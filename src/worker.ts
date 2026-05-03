// Suppress defuddle's internal error logging
const _stderr = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk: any, ...args: any[]) => {
	if (typeof chunk === "string" && (chunk.includes("Defuddle Error") || chunk.includes("pseudo-class"))) return true
	return _stderr(chunk, ...args)
}
console.error = () => {}

import { Defuddle } from "defuddle/node"
import { parseHTML } from "linkedom"

declare const self: Worker

const MARKDOWN_SIGNAL = /^(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s|\[.+\]\(.+\))/m
const DEFUDDLE_TIMEOUT = 300

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
	Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])

const fallbackExtract = (html: string) => {
	const { document } = parseHTML(html)
	const t = document.querySelector("title")?.textContent || ""
	const el = document.querySelector("main") ?? document.querySelector("article") ?? document.querySelector("body")
	return { title: t, content: el?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? "" }
}

const SPA_SIGNATURES = /mintcdn\.com|__MINTLIFY|__NEXT_DATA__|window\.__OVERMIND_MUTATIONS|<div id="root"|<div id="__next"/i

const tryRawMd = async (url: string) => {
	if (/\.md(\?|$)/.test(url)) return null
	const mdUrl = url.replace(/\/?(\?|#|$)/, ".md$1")
	try {
		const r = await fetch(mdUrl, { redirect: "follow", headers: { Accept: "text/markdown,text/plain" } })
		if (!r.ok) return null
		const txt = await r.text()
		if (txt.startsWith("<") || !MARKDOWN_SIGNAL.test(txt)) return null
		return { url: r.url.replace(/\.md(\?|#|$)/, "$1"), text: txt }
	} catch {
		return null
	}
}

self.onmessage = async (e: MessageEvent<{ url: string }>) => {
	const { url } = e.data
	try {
		const res = await fetch(url, { redirect: "follow", headers: { Accept: "text/markdown" } })
		if (!res.ok) {
			self.postMessage({ ok: false, error: `HTTP ${res.status}: ${url}` })
			return
		}

		const text = await res.text()
		const finalUrl = res.url
		const ct = res.headers.get("content-type") ?? ""

		if (ct.includes("text/markdown") || (!ct.includes("text/html") && MARKDOWN_SIGNAL.test(text))) {
			const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(finalUrl).pathname
			self.postMessage({ ok: true, url: finalUrl, title, content: text })
			return
		}

		// Mintlify / SPA detection: server returned HTML shell with no real content.
		// Many docs platforms expose a raw markdown twin at <url>.md — try that first.
		if (SPA_SIGNATURES.test(text)) {
			const raw = await tryRawMd(finalUrl)
			if (raw) {
				const title = raw.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(raw.url).pathname
				self.postMessage({ ok: true, url: raw.url, title, content: raw.text })
				return
			}
		}

		const cleaned = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")

		try {
			const result = await withTimeout(Defuddle(cleaned, finalUrl, { markdown: true }), DEFUDDLE_TIMEOUT)
			self.postMessage({ ok: true, url: finalUrl, title: result.title || "", content: result.content || "" })
		} catch {
			const { title, content } = fallbackExtract(cleaned)
			self.postMessage({ ok: true, url: finalUrl, title, content })
		}
	} catch (err: any) {
		self.postMessage({ ok: false, error: err?.message ?? "Unknown error" })
	}
}

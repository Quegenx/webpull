#!/usr/bin/env bun
import { cpus } from "node:os"
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { frontmatter } from "./convert"
import { discover } from "./discover"
import { extractOpenAPISpec, openAPIToMarkdownFiles } from "./openapi"
import { WorkerPool } from "./pool"
import { createUI } from "./ui"
import { write } from "./write"

interface Config {
	url: string
	out: string
	max: number
	exclude?: RegExp
	include?: RegExp
}

const parseArgs = (args: string[]): Config => {
	if (!args.length || args.includes("-h") || args.includes("--help")) {
		console.log(`
  webpull - Pull docs into markdown

  Usage:  webpull <url> [options]

    -o, --out <dir>      Output directory (default: ./<hostname>)
    -m, --max <n>        Max pages (default: 500)
    -e, --exclude <re>   Drop URLs whose path matches this regex
    -i, --include <re>   Keep only URLs whose path matches this regex
`)
		process.exit(0)
	}

	let raw = args[0]!
	if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`

	let url: URL
	try {
		url = new URL(raw)
	} catch {
		console.error(`Bad URL: ${args[0]}`)
		process.exit(1)
	}

	let out = `./${url.hostname}`
	let max = 500
	let exclude: RegExp | undefined
	let include: RegExp | undefined

	const compile = (pat: string, flag: string) => {
		try {
			return new RegExp(pat)
		} catch (e) {
			console.error(`Bad ${flag} regex: ${pat}`)
			process.exit(1)
		}
	}

	for (let i = 1; i < args.length; i++) {
		const arg = args[i]
		const next = args[i + 1]
		if (("-o" === arg || "--out" === arg) && next) {
			out = next
			i++
		} else if (("-m" === arg || "--max" === arg) && next) {
			max = +next
			i++
		} else if (("-e" === arg || "--exclude" === arg) && next) {
			exclude = compile(next, "--exclude")
			i++
		} else if (("-i" === arg || "--include" === arg) && next) {
			include = compile(next, "--include")
			i++
		}
	}

	return { url: url.href, out: resolve(out), max, exclude, include }
}

const openAPIFallback = async (seedUrl: string, outDir: string): Promise<boolean> => {
	const res = await fetch(seedUrl, { redirect: "follow" })
	if (!res.ok) return false
	const html = await res.text()
	const spec = extractOpenAPISpec(html)
	if (!spec) return false
	const files = openAPIToMarkdownFiles(spec, res.url || seedUrl)
	process.stderr.write(`  Found inline OpenAPI spec, writing ${files.length} files\n`)
	for (const f of files) {
		const full = join(outDir, f.path)
		await mkdir(dirname(full), { recursive: true })
		await Bun.write(full, frontmatter(f.title, f.url) + f.content)
	}
	return true
}

const program = Effect.gen(function* () {
	const config = parseArgs(process.argv.slice(2))
	const t0 = performance.now()
	const workerCount = Math.max(8, cpus().length * 2)
	const pool = new WorkerPool(workerCount)

	process.stderr.write(`\n  \x1b[1m⚡ webpull\x1b[0m \x1b[90m· discovering pages...\x1b[0m\n\n`)

	try {
		const urls = yield* discover(config.url, config.max, {
			exclude: config.exclude,
			include: config.include,
		})
		if (!urls.length) {
			process.stderr.write("  No pages found. Trying inline OpenAPI fallback...\n")
			const ok = yield* Effect.tryPromise(() => openAPIFallback(config.url, config.out)).pipe(
				Effect.catchAll(() => Effect.succeed(false)),
			)
			if (ok) {
				const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
				process.stderr.write(`\n  \x1b[32m\x1b[1mDone!\x1b[0m via OpenAPI in ${elapsed}s\n\n`)
				return
			}
			process.stderr.write("  No pages found.\n")
			process.exit(1)
		}

		const tDisc = performance.now()
		const total = urls.length
		const ui = createUI(config.url, config.out, workerCount)

		let ok = 0
		let err = 0
		const recentFiles: string[] = []
		const workerStates = new Array<"idle" | "busy">(workerCount).fill("idle")
		const workerMap = new Map<number, number>()
		let nextSlot = 0
		let lastRender = 0

		const tick = () => {
			const now = performance.now()
			if (now - lastRender < 80) return
			lastRender = now
			ui.render({ total, ok, err, elapsed: (now - tDisc) / 1000, workerStates, recentFiles })
		}

		yield* Effect.tryPromise(() =>
			pool.pullAll(
				urls,
				(idx) => {
					const slot = nextSlot++ % workerCount
					workerMap.set(idx, slot)
					workerStates[slot] = "busy"
					tick()
				},
				(result, idx) => {
					const slot = workerMap.get(idx) ?? 0
					workerStates[slot] = "idle"
					workerMap.delete(idx)

					if (result.ok) {
						ok++
						const finalUrl = result.url ?? urls[idx]!
						const title = result.title || new URL(finalUrl).pathname
						const page = {
							url: finalUrl,
							title,
							markdown: frontmatter(title, finalUrl) + (result.content ?? ""),
						}

						let filepath = new URL(finalUrl).pathname
						if (filepath.endsWith("/")) filepath += "index"
						filepath = filepath.replace(/\.html?$/, "").replace(/^\//, "")
						if (!filepath.endsWith(".md")) filepath += ".md"
						recentFiles.push(filepath)

						Effect.runPromise(write(page, config.out))
					} else {
						err++
					}
					tick()
				},
			),
		)

		ui.render({ total, ok, err, elapsed: (performance.now() - tDisc) / 1000, workerStates, recentFiles })
		ui.finish()

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
		const pps = Math.round(ok / ((performance.now() - tDisc) / 1000))

		process.stderr.write(
			`\n  \x1b[32m\x1b[1mDone!\x1b[0m ${ok} pages in ${elapsed}s \x1b[90m(${pps} pages/sec)\x1b[0m\n`,
		)
		if (err) process.stderr.write(`  \x1b[31m${err} failed\x1b[0m\n`)
		process.stderr.write("\n")
	} finally {
		pool.terminate()
	}
})

Effect.runPromise(program).catch((e) => {
	console.error(e)
	process.exit(1)
})

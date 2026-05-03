import { Effect } from "effect"
import { parseHTML } from "linkedom"

const IGNORED = /\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i

const NAV_SELECTORS = [
	"nav a[href]",
	"aside a[href]",
	'[class*="sidebar"] a[href]',
	'[class*="Sidebar"] a[href]',
	'[class*="navigation"] a[href]',
	'[class*="toc"] a[href]',
	'[class*="menu"] a[href]',
	'[role="navigation"] a[href]',
]

// --- Core fetch ---

const tryFetch = (url: string): Effect.Effect<{ text: string; url: string } | null> =>
	Effect.tryPromise(() =>
		fetch(url, { redirect: "follow" }).then(async (r) => (r.ok ? { text: await r.text(), url: r.url } : null)),
	).pipe(Effect.catchAll(() => Effect.succeed(null)))

// --- Sitemap ---

const parseLocs = (xml: string) => [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)].map((m) => m[1]!.trim())

const fetchSitemap = (url: string, depth = 0): Effect.Effect<string[], never, never> => {
	if (depth > 3) return Effect.succeed([])
	return Effect.gen(function* () {
		const r = yield* tryFetch(url)
		if (!r?.text.includes("<")) return []

		const locs = parseLocs(r.text)
		const isIndex = r.text.includes("<sitemapindex") || (r.text.includes("<sitemap>") && !r.text.includes("<urlset"))

		if (isIndex) {
			const nested = yield* Effect.all(
				locs.map((u) => fetchSitemap(u, depth + 1)),
				{ concurrency: "unbounded" },
			)
			return nested.flat()
		}
		return locs
	})
}

const sitemapFromRobots = (origin: string) =>
	Effect.gen(function* () {
		const r = yield* tryFetch(`${origin}/robots.txt`)
		if (!r) return []
		const urls = (r.text.match(/^Sitemap:\s*(.+)$/gim) ?? []).map((l) => l.replace(/^Sitemap:\s*/i, "").trim())
		if (!urls.length) return []
		const results = yield* Effect.all(
			urls.map((u) => fetchSitemap(u)),
			{ concurrency: "unbounded" },
		)
		return results.flat()
	})

// --- llms.txt (Mintlify, Fern, and others publish this) ---

const fetchLlmsTxt = (url: string) =>
	Effect.gen(function* () {
		const r = yield* tryFetch(url)
		if (!r) return []
		// Reject HTML 404 pages dressed as 200
		if (r.text.startsWith("<") || !r.text.includes("http")) return []
		const urls: string[] = []
		for (const m of r.text.matchAll(/\((https?:\/\/[^\s)]+)\)/g)) {
			let u = m[1]!
			// Strip trailing .md so the URL matches the rendered page; worker will re-add for raw fetch
			u = u.replace(/\.md(#.*)?$/, "$1")
			urls.push(u)
		}
		return urls
	})

// --- Nav extraction ---

const extractNav = (base: URL, html: string) =>
	Effect.sync(() => {
		const { document } = parseHTML(html)
		const urls = new Set<string>()

		for (const sel of NAV_SELECTORS) {
			for (const link of document.querySelectorAll(sel)) {
				const href = link.getAttribute("href")
				if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue
				try {
					const r = new URL(href, base)
					r.hash = r.search = ""
					if (!IGNORED.test(r.pathname)) urls.add(r.href)
				} catch {}
			}
		}

		urls.add(base.href)
		return [...urls]
	})

// --- Crawl ---

const extractLinks = (html: string, base: URL, visited: Set<string>, scope: string) => {
	const out: string[] = []
	for (const m of html.matchAll(/href=["'](.*?)["']/gi)) {
		try {
			const r = new URL(m[1]!, base)
			r.hash = r.search = ""
			if (
				r.hostname === base.hostname &&
				r.pathname.startsWith(scope) &&
				!IGNORED.test(r.pathname) &&
				!visited.has(r.href)
			)
				out.push(r.href)
		} catch {}
	}
	return [...new Set(out)]
}

const crawl = (base: URL, max: number, scope: string) =>
	Effect.gen(function* () {
		const visited = new Set<string>()
		const queue = [base.href]
		const found: string[] = []

		while (queue.length > 0 && found.length < max) {
			const batch = queue.splice(0, Math.min(20, max - found.length)).filter((u) => !visited.has(u))
			for (const u of batch) visited.add(u)

			const results = yield* Effect.all(
				batch.map((url) =>
					tryFetch(url).pipe(
						Effect.map((r) => {
							if (!r?.text.includes("</html")) return []
							found.push(r.url)
							return extractLinks(r.text, base, visited, scope)
						}),
					),
				),
				{ concurrency: 20 },
			)

			for (const links of results) {
				for (const link of links) {
					if (!visited.has(link) && found.length + queue.length < max) queue.push(link)
				}
			}
		}
		return found
	})

// --- Scoping ---

// Candidate scopes from narrowest to widest. The seed's own dir, every parent
// dir up to root. Discovery picks whichever scope yields the most matches in
// the sitemap/nav, so a deep seed like /a/b/c/d still finds siblings at /a/b/.
const getScopeCandidates = (pathname: string): string[] => {
	const seedDir = (() => {
		if (pathname === "/" || pathname === "") return "/"
		if (pathname.endsWith("/")) return pathname
		if (/\.\w+$/.test(pathname)) return pathname.replace(/\/[^/]*$/, "/") || "/"
		return `${pathname.replace(/\/$/, "")}/`
	})()
	const segs = seedDir.split("/").filter(Boolean)
	const out: string[] = []
	for (let i = segs.length; i > 0; i--) out.push(`/${segs.slice(0, i).join("/")}/`)
	out.push("/")
	return [...new Set(out)]
}

const filterAndDedupe = (urls: string[], hosts: Set<string>, scope: string, max: number) => {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of urls) {
		try {
			const u = new URL(raw)
			if (!hosts.has(u.hostname) || !u.pathname.startsWith(scope) || IGNORED.test(u.pathname)) continue
			u.hash = u.search = ""
			if (!seen.has(u.pathname)) {
				seen.add(u.pathname)
				out.push(u.href)
			}
		} catch {}
	}
	return out.slice(0, max)
}

// --- Main ---

export const discover = (baseUrl: string, max: number) =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () => fetch(baseUrl, { redirect: "follow" }),
			catch: () => new Error(`Failed to fetch ${baseUrl}`),
		})
		if (!res.ok) return yield* Effect.fail(new Error(`HTTP ${res.status}: ${baseUrl}`))

		const actual = new URL(res.url)
		const original = new URL(baseUrl)
		const html = yield* Effect.tryPromise({
			try: () => res.text(),
			catch: () => new Error("Failed to read response"),
		})

		if (actual.href !== original.href) process.stderr.write(`  Resolved to ${actual.href}\n`)

		const hosts = new Set([original.hostname, actual.hostname])
		const scopeCandidates = getScopeCandidates(actual.pathname)

		const origins = [...new Set([original.origin, actual.origin])]
		const basePaths = new Set<string>(["/", ...scopeCandidates])

		const strategies: Effect.Effect<string[]>[] = []
		for (const o of origins) {
			strategies.push(sitemapFromRobots(o))
			for (const bp of basePaths) {
				for (const name of ["sitemap.xml", "sitemap_index.xml", "sitemap-0.xml"]) {
					strategies.push(fetchSitemap(`${o}${bp}${name}`))
				}
				strategies.push(fetchLlmsTxt(`${o}${bp}llms.txt`))
			}
		}

		const results = yield* Effect.all(strategies, { concurrency: "unbounded" })

		const allUrls: string[] = []
		for (const urls of results) {
			for (const u of urls) {
				allUrls.push(u)
				try {
					hosts.add(new URL(u).hostname)
				} catch {}
			}
		}

		// Walk scopes narrow → wide. Keep widening only while the next scope's
		// count is ≥1.5× the current scope's count (i.e. widening genuinely
		// uncovers more of the seed's section). Stop the moment growth flattens
		// — that flat boundary is where the seed's section ends and unrelated
		// sections of the site begin (e.g. tanstack.com has /query/, /router/,
		// /start/ — /query/latest/'s count ≈ /query/'s count, so we stop at
		// /query/latest/ instead of pulling all of tanstack.com).
		const pickBestScope = (urls: string[]) => {
			// scopeCandidates is already narrow → wide (seed dir first, root last)
			const counts = scopeCandidates.map((scope) => ({
				scope,
				urls: filterAndDedupe(urls, hosts, scope, max),
			}))
			let chosen = counts[0]!
			for (let i = 1; i < counts.length; i++) {
				const cur = counts[i]!
				if (chosen.urls.length === 0) {
					chosen = cur
					continue
				}
				if (cur.urls.length >= chosen.urls.length * 1.5) chosen = cur
				else break
			}
			return chosen
		}

		if (allUrls.length) {
			const { urls: bestUrls } = pickBestScope(allUrls)
			if (bestUrls.length) {
				process.stderr.write(`  Found ${bestUrls.length} pages via sitemap\n`)
				return bestUrls
			}
		}

		process.stderr.write("  No sitemap, extracting from navigation...\n")
		const nav = yield* extractNav(actual, html)
		if (nav.length > 5) {
			const { urls: filtered } = pickBestScope(nav)
			if (filtered.length > 0) {
				process.stderr.write(`  Found ${filtered.length} pages from navigation\n`)
				return filtered
			}
		}

		process.stderr.write("  Falling back to link crawling...\n")
		// Crawl from the seed's own dir so we don't traverse the whole site.
		const crawlScope = scopeCandidates[0]!
		return yield* crawl(actual, max, crawlScope)
	})

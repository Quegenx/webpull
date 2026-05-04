// OpenAPI fallback for sites whose docs page is a single client-rendered
// API reference (Redoc, Scalar, Stoplight Elements, etc.). These pages have
// no sitemap and no nav links in the SSR HTML, but they do embed the full
// OpenAPI document inline — either as raw JSON in a script tag, or
// backslash-escaped inside a Next.js RSC payload.

const extractObjectAt = (text: string, start: number): string | null => {
	if (text[start] !== "{") return null
	let depth = 0
	let inStr = false
	let esc = false
	for (let i = start; i < text.length; i++) {
		const c = text[i]
		if (esc) {
			esc = false
			continue
		}
		if (c === "\\") {
			esc = true
			continue
		}
		if (c === '"') {
			inStr = !inStr
			continue
		}
		if (inStr) continue
		if (c === "{") depth++
		else if (c === "}") {
			depth--
			if (depth === 0) return text.slice(start, i + 1)
		}
	}
	return null
}

const tryParseAt = (text: string, start: number): unknown | null => {
	const slice = extractObjectAt(text, start)
	if (!slice) return null
	try {
		const obj = JSON.parse(slice) as Record<string, unknown>
		if (obj && typeof obj === "object" && "openapi" in obj && "paths" in obj) return obj
		if (obj && typeof obj === "object" && "swagger" in obj && "paths" in obj) return obj
	} catch {}
	return null
}

const findInVariant = (text: string): unknown | null => {
	const re = /["']?(?:openapi|swagger)["']?\s*:\s*["']\d/g
	let m: RegExpExecArray | null
	// biome-ignore lint/suspicious/noAssignInExpressions: regex iter
	while ((m = re.exec(text))) {
		let depth = 0
		for (let i = m.index; i >= 0; i--) {
			const c = text[i]
			if (c === "}") depth++
			else if (c === "{") {
				if (depth === 0) {
					const parsed = tryParseAt(text, i)
					if (parsed) return parsed
					break
				}
				depth--
			}
		}
	}
	return null
}

// Strip exactly one layer of JS-string-literal escaping. We must preserve
// JSON-internal escapes (`\n`, `\"`, `\\`) so the result is still valid JSON.
// Trick: route `\\` through a NUL placeholder so the second pass on `\"`
// doesn't mistake the slash from `\\` for an escape opener.
const unescapeOnce = (s: string) => s.replace(/\\\\/g, "\x00").replace(/\\"/g, '"').replace(/\x00/g, "\\")

export const extractOpenAPISpec = (html: string): Record<string, unknown> | null => {
	const variants = [html]
	const once = unescapeOnce(html)
	if (once !== html) variants.push(once)
	const twice = unescapeOnce(once)
	if (twice !== once) variants.push(twice)

	for (const v of variants) {
		const found = findInVariant(v)
		if (found) return found as Record<string, unknown>
	}
	return null
}

interface RefObj {
	$ref?: string
}
type AnyObj = Record<string, unknown>

const isObj = (x: unknown): x is AnyObj => !!x && typeof x === "object" && !Array.isArray(x)

const refName = (ref: string) => ref.split("/").pop() ?? ref

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``

const renderSchema = (s: unknown) => fence("json", JSON.stringify(s, null, 2))

const renderOperation = (method: string, path: string, op: AnyObj): string => {
	const out: string[] = []
	out.push(`# ${method.toUpperCase()} ${path}\n`)
	if (op.summary) out.push(`**${op.summary}**\n`)
	if (op.description) out.push(`${op.description}\n`)
	if (op.operationId) out.push(`\`operationId\`: \`${op.operationId}\`\n`)

	const params = op.parameters as AnyObj[] | undefined
	if (params?.length) {
		out.push("## Parameters\n")
		for (const p of params) {
			const schema = (p.schema as RefObj | AnyObj | undefined) ?? {}
			const t =
				(schema as AnyObj).type ?? ((schema as RefObj).$ref ? refName((schema as RefObj).$ref!) : "")
			out.push(`- \`${p.name}\` (${p.in}${p.required ? ", required" : ""}): ${t}${p.description ? ` — ${p.description}` : ""}`)
		}
		out.push("")
	}

	const body = op.requestBody as AnyObj | undefined
	if (body) {
		out.push("## Request body\n")
		if (body.description) out.push(`${body.description}\n`)
		const content = body.content as AnyObj | undefined
		const json = content?.["application/json"] as AnyObj | undefined
		if (json?.schema) out.push(renderSchema(json.schema))
		out.push("")
	}

	const responses = op.responses as AnyObj | undefined
	if (responses) {
		out.push("## Responses\n")
		for (const [code, raw] of Object.entries(responses)) {
			const r = raw as AnyObj
			const ref = (r as RefObj).$ref
			out.push(`### \`${code}\`${r.description ? ` — ${r.description}` : ""}`)
			if (ref) {
				out.push(`Ref: \`${ref}\`\n`)
				continue
			}
			const content = r.content as AnyObj | undefined
			const json = content?.["application/json"] as AnyObj | undefined
			if (json?.schema) out.push(renderSchema(json.schema))
			out.push("")
		}
	}
	return out.join("\n")
}

const slugify = (s: string) =>
	s
		.replace(/^\//, "")
		.replace(/\{([^}]+)\}/g, "_$1_")
		.replace(/[^a-zA-Z0-9/_-]+/g, "-")
		.replace(/^-+|-+$/g, "")

export interface OpenAPIFile {
	path: string
	content: string
	url: string
	title: string
}

export const openAPIToMarkdownFiles = (spec: AnyObj, sourceUrl: string): OpenAPIFile[] => {
	const files: OpenAPIFile[] = []
	const info = (spec.info as AnyObj | undefined) ?? {}
	const title = (info.title as string) ?? "API"
	const version = (info.version as string) ?? ""
	const seed = new URL(sourceUrl)
	const seedDir = seed.pathname.replace(/\/$/, "")

	const idx: string[] = []
	idx.push(`# ${title}${version ? ` (v${version})` : ""}\n`)
	idx.push(`Source: ${sourceUrl}\n`)
	if (info.description) idx.push(`${info.description}\n`)
	const servers = spec.servers as AnyObj[] | undefined
	if (servers?.length) {
		idx.push("## Servers\n")
		for (const s of servers) idx.push(`- \`${s.url}\`${s.description ? ` — ${s.description}` : ""}`)
		idx.push("")
	}
	idx.push("## Endpoints\n")
	const paths = (spec.paths as AnyObj | undefined) ?? {}
	for (const [p, methods] of Object.entries(paths)) {
		if (!isObj(methods)) continue
		for (const [m, opRaw] of Object.entries(methods)) {
			if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(m)) continue
			if (!isObj(opRaw)) continue
			const op = opRaw
			const slug = `${m}-${slugify(p)}`.replace(/\/+/g, "_")
			const rel = `${seedDir.replace(/^\//, "") || "api"}/${slug}.md`
			idx.push(`- [${m.toUpperCase()} ${p}](${slug}.md)${op.summary ? ` — ${op.summary}` : ""}`)
			files.push({
				path: rel,
				content: renderOperation(m, p, op),
				url: `${seed.origin}${seedDir}#${slug}`,
				title: `${m.toUpperCase()} ${p}`,
			})
		}
	}

	const components = spec.components as AnyObj | undefined
	const schemas = components?.schemas as AnyObj | undefined
	if (schemas && Object.keys(schemas).length) {
		idx.push("\n## Schemas\n")
		for (const [name, schema] of Object.entries(schemas)) {
			idx.push(`### ${name}\n`)
			idx.push(renderSchema(schema))
			idx.push("")
		}
	}

	const security = components?.securitySchemes as AnyObj | undefined
	if (security) {
		idx.push("## Security schemes\n")
		idx.push(renderSchema(security))
	}

	const indexPath = `${seedDir.replace(/^\//, "") || "api"}/index.md`
	files.unshift({
		path: indexPath,
		content: idx.join("\n"),
		url: sourceUrl,
		title,
	})
	return files
}

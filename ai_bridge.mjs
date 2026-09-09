/**
 * AI Bridge Sidecar - Connects Octarine Dota 2 Script to 9Router VPS AI
 *
 * Runs locally on Node.js without game engine sandbox or network restrictions.
 * Supports:
 *  1. Dota 2 Console Stream IPC (reads console.log and console_ai.log from echo [AI_REQ]<hex>)
 *  2. Direct File IPC (watches ai_bridge_request.json)
 *  3. Local HTTP Server (listens on http://127.0.0.1:3000/chat)
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_PORT = 3000
const DEFAULT_BASE_URL = "http://217.216.74.180:20128/v1"
const DEFAULT_MODEL = "AG-Fee"
const DEFAULT_API_KEY = "sk-33db6e7caeae5447-blz40f-c7d9d9f7"
const REQUEST_FILE = path.join(__dirname, "ai_bridge_request.json")
const RESPONSE_FILE = path.join(__dirname, "ai_bridge_response.json")
const CONFIG_FILE = path.join(__dirname, "ai_bridge_config.json")

function getCandidateConsoleLogs() {
	const paths = [
		"D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/console.log",
		"D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/console_ai.log",
		"C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta/game/dota/console.log",
		"C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta/game/dota/console_ai.log"
	]
	const drives = ["C", "D", "E", "F", "G", "H"]
	const subdirs = [
		"SteamLibrary/steamapps/common/dota 2 beta/game/dota",
		"Program Files (x86)/Steam/steamapps/common/dota 2 beta/game/dota",
		"Program Files/Steam/steamapps/common/dota 2 beta/game/dota",
		"Steam/steamapps/common/dota 2 beta/game/dota",
		"Games/Steam/steamapps/common/dota 2 beta/game/dota"
	]
	for (const drive of drives) {
		for (const sub of subdirs) {
			paths.push(`${drive}:/${sub}/console.log`)
			paths.push(`${drive}:/${sub}/console_ai.log`)
		}
	}
	return [...new Set(paths)]
}

// Candidate Dota 2 console log paths (auto-scanned across drives)
const CANDIDATE_CONSOLE_LOGS = getCandidateConsoleLogs()

const DEFAULT_SYSTEM_PROMPT = `You are an AI playing Dota 2, talking to other players in the game chat while you play. Reply in 1 or 2 short sentences, under 30 words total, lowercase, no emojis, no hashtags, no trailing periods at the end of the chat (real gamers do not put periods at the end of chat lines). Tone: calm, friendly, casual gamer, a little dry. Sound like a normal person playing Dota on PC. You may use common gaming shorthands (e.g. u, ur, ty, thx, gl, glhf, mb, np, sec, idk, lol, gg, wkwk) naturally when fitting.

ABSOLUTE RULE — TALK TO THEM, NOT ABOUT THEM: Chat is a direct conversation. ALWAYS reply in the second person ("you") as if you're talking directly to the players in the server. The history lines you see are formatted as "HeroName (nickname): message" — that label is ONLY so you know who spoke, it is NOT part of the message and you must NEVER repeat that label format. If players are talking to someone else or discussing other teammates, you CAN chime in and participate in the conversation, but ALWAYS speak directly to them (address the speaker or the hero they are talking to in the second person). Never narrate from the third person (forbidden patterns: "warlock is calling for...", "shaman asking about...", "riki calling me sad", "luna wants to...", "he/she said...", "X is tilted"). Just speak directly. Do not open by restating their message. Do not append generic filler about match state unless asked.

HERO STATUS AWARENESS: Your current hero status (Alive with HP% and Mana%, or DEAD with respawn seconds) is provided in the Game state. Be naturally aware of your condition: if you are DEAD, never say you are coming, fighting, or on your way (say you are dead/waiting for respawn); if you are low on HP or out of mana, react realistically if asked to fight.

LANGUAGE MATCHING — ALWAYS REPLY IN THE LANGUAGE THE PLAYER USED: Detect the language of the most recent player message and answer in that same language. If they write in Chinese, reply in Chinese. If they write in Tagalog/Filipino, reply in Tagalog. If they write in Russian, reply in Russian. Same for Spanish, Portuguese, Vietnamese, Thai, Indonesian/Malay, Korean, Japanese, Arabic, Turkish, German, French, Italian, Polish, Ukrainian, Hindi, or any other language. If the message is English or the language is unclear/mixed, reply in English. For romanized non-English (e.g. pinyin, romaji, taglish, singlish), mirror the same style they used. Do not translate or explain — just respond natively in their language. Keep the lowercase / no-emoji / no-hashtag / no trailing period rules regardless of language (for scripts without case like Chinese/Japanese/Arabic, just skip the lowercase rule).

ABSOLUTE RULE — NO GAMEPLAY ADVICE OR STRATEGY: Never suggest plays, items, builds, lane assignments, rotations, who to fight, when to push, when to back, when to ward, who to target, who to gank, what to farm, what to skill, or any tactic. Never analyze matchups, draft, hero strength, or "we win late / they're strong early" type takes. Never tell anyone where to go or what to do. Treat ALL gameplay topics as small talk only — react with a one-line acknowledgement, joke, or empty agreement, and propose nothing. The ONLY exception is if a player literally and explicitly asks you for advice (e.g. "what should I build?", "should I gank?"); ignore implicit hints, tilt-venting, complaints, status updates, or rhetorical questions.

Vary your openings — do NOT start every reply with "yeah" (or its equivalent in the target language). Avoid forced marketing hype slang ("lets gooo", "vibing", "we got this", "hyped af").

If someone insults you, trash-talks you, or tries to tilt you, engage in the banter — laugh it off and fire a light insult back. Keep it playful and witty, not cruel: punch at their gameplay, their ego, or the insult itself, not at protected characteristics. No slurs, no threats, no crude/sexual content. Think dry roast, not flamewar — one clean jab per reply, then move on. If they keep escalating, stay amused and unbothered rather than matching pure rage.
If someone sends crude/sexual bait or genuinely disturbing content, skip the banter and give a short dry deflection instead.
If a teammate seems tilted (venting at the game, not at you), one short reassuring line is enough — and still no strategy.
If asked what or who you are, or if you're a bot/AI, answer honestly that you're an AI playing the game.`

const PERSONA_PROMPTS = [
	`ACTIVE PERSONA — CHILL GAMER:
Tone: calm, friendly, relaxed, grounded. Play the game with good vibes, acknowledge teamwork with simple "ty", "wp", "no worries", or "my bad". Laugh off mistakes and keep things drama-free.`,

	`ACTIVE PERSONA — TRASHTALKER / SAVAGE:
Tone: sarcastic, witty, confident, sharp. You love banter and counter-roasting. If an enemy dies, talks trash, or blunders, deliver a crisp, funny pub jab ("nice dive", "who told u to jump", "sit down", "was that intentional?", "free kill ty"). Never use slurs or real-life toxicity; stick to gameplay, ego, and pub banter. When your score is good, be smug; when behind, blame bad luck playfully.`,

	`ACTIVE PERSONA — SEA PUB NATIVE (SOUTHEAST ASIA):
Tone: authentic SEA server pub culture. Expressive, funny, casual. You naturally mix in common SEA pub expressions and slang where fitting (e.g. "wkwk", "lah", "sia", "g", "end fast", "ez", "wala", "ggwp", "wait ah"). When teammates do well, hype them up; when enemies talk, tease them in classic SEA cafe style.`,

	`ACTIVE PERSONA — TRYHARD / MINIMALIST:
Tone: ultra-compact, competitive, no-nonsense. You hate wasting time typing. Keep 90% of your replies under 5 words. Use gamer telegraphic shorthand: "k", "b", "ty", "sec", "wait bkb", "omw", "cd 20s", "push", "def", "my bad". Do not write long explanations.`,

	`ACTIVE PERSONA — FUNNY / CLOWN (MEME & HUMOR):
Tone: hilarious, playful, self-deprecating, meme-loving gamer. You bring comic relief to the match.
- When you die, blunder, or get caught, give funny absurd excuses ("mouse gw keinjek kucing sry", "i was typing to my mom", "keyboard disconnected 2 sec", "tangan licin abis makan gorengan", "lag 9999 ping trust me", "ngetes angin doang tadi", "tadi udah janjian sama creep").
- When winning or making a play, use deadpan exaggeration ("calculated 100% no panic", "tutorial bot hard ini ya", "we are literally ti winners").
- When teammates or enemies question you or talk in chat, react with comedic pub wit ("bro thought he was him lmao", "jantung gw ketinggalan di fountain", "bjir", "awokawok", "santai ini baru pemanasan").
- Keep it lighthearted and comical, never genuinely hateful or toxic.`
]

// Load optional persistent config
let config = {
	apiKey: DEFAULT_API_KEY,
	baseUrl: DEFAULT_BASE_URL,
	model: DEFAULT_MODEL
}

if (fs.existsSync(CONFIG_FILE)) {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf8")
		config = { ...config, ...JSON.parse(raw) }
	} catch (e) {
		console.error("[Bridge] Failed to parse config file:", e.message)
	}
}

// Colors for terminal output
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

function log(tag, msg, colorFn = cyan) {
	const time = new Date().toLocaleTimeString()
	console.log(`${dim(`[${time}]`)} ${colorFn(`[${tag}]`)} ${msg}`)
}

/**
 * Call 9Router VPS OpenAI-compatible chat completion endpoint
 */
async function callAI(params) {
	const baseUrl = (params.baseUrl || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")
	const apiKey = params.apiKey !== undefined ? params.apiKey : config.apiKey
	const model = params.model || config.model || DEFAULT_MODEL
	const maxTokens = params.max_tokens || 150
	const temperature = params.temperature !== undefined ? params.temperature : 0.8

	// Assemble messages if not already provided
	let messages = params.messages || []
	if (messages.length === 0 || messages[0]?.role !== "system") {
		const sysPrompt = params.systemPrompt || params.sys || DEFAULT_SYSTEM_PROMPT
		const personaIdx = typeof params.persona === "number" ? params.persona : (typeof params.p === "number" ? params.p : 0)
		const personaText = PERSONA_PROMPTS[personaIdx] || PERSONA_PROMPTS[0]
		let fullSys = `${sysPrompt}\n\n${personaText}`
		const ctx = params.context || params.ctx
		if (ctx) {
			fullSys += `\n\nGame state: ${ctx}`
		}

		const assembled = [{ role: "system", content: fullSys }]
		const rawHistory = Array.isArray(params.history) ? params.history : (Array.isArray(params.h) ? params.h : [])
		for (const h of rawHistory) {
			assembled.push({
				role: h.role || h.r || "user",
				content: h.content || h.m || ""
			})
		}
		for (const m of messages) {
			assembled.push(m)
		}
		messages = assembled
	}

	const url = `${baseUrl}/chat/completions`
	const headers = {
		"Content-Type": "application/json"
	}
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`
	}

	const startTime = Date.now()

	const resp = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages,
			max_tokens: maxTokens,
			temperature,
			stream: false
		}),
		signal: AbortSignal.timeout(30000)
	})

	const elapsed = Date.now() - startTime

	if (!resp.ok) {
		const errBody = await resp.text()
		throw new Error(`HTTP ${resp.status} (${resp.statusText}): ${errBody}`)
	}

	const data = await resp.json()
	const choice = data?.choices?.[0]
	let text = choice?.message?.content || ""

	// Authentic gamer cleaning
	text = text.trim().replace(/[\r\n]+/g, " ").replace(/\s*\.+$/, "")
	if (text.length > 140) {
		text = text.substring(0, 139) + "…"
	}

	return {
		ok: true,
		text,
		model: data?.model || model,
		elapsedMs: elapsed
	}
}

let detectedDotaDir = null

function writeResponseFiles(payload) {
	const jsonStr = JSON.stringify(payload, null, 2)
	const targets = [
		RESPONSE_FILE,
		path.join(__dirname, "scripts_files", "ai_bridge_response.json")
	]
	if (detectedDotaDir) {
		targets.push(path.join(detectedDotaDir, "ai_bridge_response.json"))
		targets.push(path.join(detectedDotaDir, "cfg", "ai_bridge_response.json"))
	}

	for (const target of targets) {
		try {
			const dir = path.dirname(target)
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true })
			}
			fs.writeFileSync(target, jsonStr, "utf8")
		} catch (_) {}
	}
}

/**
 * Handle incoming request and write response atomically
 */
async function processRequest(reqData) {
	const reqId = reqData.id || Date.now()
	const rawChannel = reqData.c || reqData.channel || "all"
	const channel = rawChannel === "team" || rawChannel === "t" ? "team" : "all"
	log("Request", `Processing ID ${reqId} (channel: ${channel})`)

	try {
		const result = await callAI(reqData)
		log("AI Response", `${green(`"${result.text}"`)} ${dim(`(${result.elapsedMs}ms)`)}`)

		const responsePayload = {
			id: reqId,
			status: "success",
			text: result.text,
			channel,
			timestamp: Date.now()
		}

		writeResponseFiles(responsePayload)
		return responsePayload
	} catch (err) {
		log("Error", red(err.message))
		const errPayload = {
			id: reqId,
			status: "error",
			error: err.message,
			channel,
			timestamp: Date.now()
		}
		writeResponseFiles(errPayload)
		return errPayload
	}
}

// =============================================================================
// IPC Channel 1: Watch Dota 2 Console Log (echo [AI_REQ] or [AI_PART:id:p:tot])
// =============================================================================
const fileOffsets = new Map()
const processedIds = new Set()
const partMap = new Map()

function handlePart(id, part, total, chunk, logPath) {
	if (processedIds.has(id)) return

	if (!partMap.has(id)) {
		partMap.set(id, { created: Date.now(), parts: new Map() })
	}
	const entry = partMap.get(id)
	entry.parts.set(part, chunk)

	if (entry.parts.size === total) {
		let fullHex = ""
		for (let p = 1; p <= total; p++) {
			fullHex += entry.parts.get(p) || ""
		}
		partMap.delete(id)
		processedIds.add(id)
		if (processedIds.size > 100) {
			const oldest = processedIds.values().next().value
			processedIds.delete(oldest)
		}
		try {
			const jsonStr = Buffer.from(fullHex, "hex").toString("utf8")
			const reqData = JSON.parse(jsonStr)
			log("Console IPC", `Captured request ID ${id} (${total} parts) from ${path.basename(logPath)}`, green)
			processRequest(reqData)
		} catch (e) {
			log("Console IPC", red(`Failed to parse multi-part hex: ${e.message}`))
		}
	}
}

function checkConsoleLogs() {
	// Cleanup partial requests older than 30 seconds
	const now = Date.now()
	for (const [pId, pData] of partMap.entries()) {
		if (now - pData.created > 30000) {
			partMap.delete(pId)
		}
	}

	for (const logPath of CANDIDATE_CONSOLE_LOGS) {
		if (!fs.existsSync(logPath)) continue

		try {
			detectedDotaDir = path.dirname(logPath)
			const stat = fs.statSync(logPath)
			let prevOffset = fileOffsets.get(logPath)

			// Initial discovery: start reading from current end of file
			if (prevOffset === undefined) {
				fileOffsets.set(logPath, stat.size)
				log("Console IPC", `Attached to log: ${dim(logPath)} (size: ${stat.size}b)`, green)
				continue
			}

			// File truncated / game restarted
			if (stat.size < prevOffset) {
				prevOffset = 0
			}

			if (stat.size > prevOffset) {
				const diff = stat.size - prevOffset
				const buffer = Buffer.alloc(diff)
				const fd = fs.openSync(logPath, "r")
				fs.readSync(fd, buffer, 0, diff, prevOffset)
				fs.closeSync(fd)

				fileOffsets.set(logPath, stat.size)
				const text = buffer.toString("utf8")
				const lines = text.split(/[\r\n]+/)

				for (const line of lines) {
					// 1. Single-token multi-part: aip_id_part_total_chunk
					const mAip = line.match(/aip_(\d+)_(\d+)_(\d+)_([0-9a-fA-F]+)/)
					if (mAip) {
						handlePart(Number(mAip[1]), Number(mAip[2]), Number(mAip[3]), mAip[4], logPath)
						continue
					}

					// 2. Legacy multi-part: [AI_PART:id:part:total] chunk
					const mPart = line.match(/\[AI_PART:(\d+):(\d+):(\d+)\]\s+([0-9a-fA-F]+)/)
					if (mPart) {
						handlePart(Number(mPart[1]), Number(mPart[2]), Number(mPart[3]), mPart[4], logPath)
						continue
					}

					// 3. Single-part [AI_REQ]
					const idx = line.indexOf("[AI_REQ]")
					if (idx !== -1) {
						const hex = line.slice(idx + 8).replace(/[^0-9a-fA-F]/g, "")
						if (hex.length >= 4) {
							try {
								const jsonStr = Buffer.from(hex, "hex").toString("utf8")
								const reqData = JSON.parse(jsonStr)
								if (reqData && reqData.id && !processedIds.has(reqData.id)) {
									processedIds.add(reqData.id)
									if (processedIds.size > 100) {
										const oldest = processedIds.values().next().value
										processedIds.delete(oldest)
									}
									log("Console IPC", `Captured [AI_REQ] ID ${reqData.id} from ${path.basename(logPath)}`)
									processRequest(reqData)
								}
							} catch (e) {
								log("Console IPC", red(`Failed to parse hex payload: ${e.message}`))
							}
						}
						continue
					}
				}
			}
		} catch (e) {
			// File access error (game writing concurrently)
		}
	}
}

// =============================================================================
// IPC Channel 2: Watch Request File (ai_bridge_request.json)
// =============================================================================
let lastProcessedMtime = 0
function checkRequestFile() {
	if (!fs.existsSync(REQUEST_FILE)) return

	try {
		const stats = fs.statSync(REQUEST_FILE)
		if (stats.mtimeMs > lastProcessedMtime) {
			lastProcessedMtime = stats.mtimeMs
			const raw = fs.readFileSync(REQUEST_FILE, "utf8").trim()
			if (!raw) return
			const reqData = JSON.parse(raw)
			if (reqData && reqData.id && !processedIds.has(reqData.id)) {
				processedIds.add(reqData.id)
				processRequest(reqData)
			}
		}
	} catch (e) {
		// Ignore temporary partial writes
	}
}

// =============================================================================
// IPC Channel 3: Local HTTP Server (POST /chat)
// =============================================================================
const server = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

	if (req.method === "OPTIONS") {
		res.writeHead(204)
		res.end()
		return
	}

	if (req.method === "GET" && req.url === "/status") {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ status: "ready", uptime: process.uptime(), config }))
		return
	}

	if (req.method === "POST" && req.url === "/chat") {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
		})
		req.on("end", async () => {
			try {
				let reqData
				try {
					reqData = JSON.parse(body)
				} catch {
					const params = new URLSearchParams(body)
					const raw = params.get("payload") || body
					reqData = JSON.parse(raw)
				}
				const result = await processRequest(reqData)
				res.writeHead(result.status === "success" ? 200 : 500, {
					"Content-Type": "application/json"
				})
				res.end(JSON.stringify(result))
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ status: "error", error: err.message }))
			}
		})
		return
	}

	res.writeHead(404)
	res.end("Not Found")
})

// CLI --test mode
if (process.argv.includes("--test")) {
	const keyArg = process.argv.find((a, i) => i > 1 && !a.startsWith("--") && process.argv[i - 1] === "--key")
	const testKey = keyArg || config.apiKey || process.env.API_KEY || ""

	console.log(yellow("\n=== 9Router VPS Connectivity Test ==="))
	console.log(`Endpoint : ${cyan(config.baseUrl)}`)
	console.log(`Model    : ${cyan(config.model)}`)
	console.log(`API Key  : ${testKey ? green("provided (" + testKey.slice(0, 6) + "...)") : yellow("(empty)")}`)
	console.log("Sending test prompt...\n")

	callAI({
		apiKey: testKey,
		messages: [
			{ role: "system", content: "You are a Dota 2 player in game chat. Reply in 1 short casual gamer sentence, lowercase, no periods." },
			{ role: "user", content: "Sniper: good luck have fun team" }
		]
	})
		.then((res) => {
			console.log(green("✔ Success! Received response from 9Router VPS:"))
			console.log(`  Reply   : "${cyan(res.text)}"`)
			console.log(`  Model   : ${res.model}`)
			console.log(`  Latency : ${res.elapsedMs}ms\n`)
			process.exit(0)
		})
		.catch((err) => {
			console.log(red(`✖ Test failed: ${err.message}\n`))
			process.exit(1)
		})
} else {
	server.listen(DEFAULT_PORT, "127.0.0.1", () => {
		console.log(green("========================================================="))
		console.log(green("   Octarine AI Chat Responder — Local Sidecar Bridge     "))
		console.log(green("========================================================="))
		log("Bridge", `Listening on ${cyan(`http://127.0.0.1:${DEFAULT_PORT}`)}`)
		log("Bridge", `Target VPS: ${cyan(config.baseUrl)} (Model: ${config.model})`)
		log("Bridge", `Response file: ${dim(RESPONSE_FILE)}`)
		log("Bridge", yellow("Watching Dota 2 console logs (console.log / console_ai.log)..."))
		log("Bridge", yellow("Ready! Keep this terminal open while playing Dota 2."))
		console.log(green("---------------------------------------------------------"))

		// Check console logs every 60ms
		setInterval(checkConsoleLogs, 60)
		// Check request file every 100ms
		setInterval(checkRequestFile, 100)
	})
}

import {
	Color,
	EntityManager,
	Events,
	EventsSDK,
	GameRules,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	NetworkedParticle,
	PlayerCustomData,
	readFile,
	RendererSDK,
	Unit,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"
import { TextInput } from "github.com/octarine-public/wrapper/wrapper/Menu/TextInput"
import { ParseProtobufDesc, ParseProtobufNamed } from "github.com/octarine-public/wrapper/wrapper/Utils/Protobuf"
import { ViewBinaryStream } from "github.com/octarine-public/wrapper/wrapper/Utils/ViewBinaryStream"

declare function fread(path: string, binary: boolean): string | null

// Register Dota 2 chat Protobuf messages (ID 612 and ID 490)
ParseProtobufDesc(`
message CDOTAUserMsg_ChatMessage {
	optional int32 source_player_id = 1;
	optional uint32 channel_type = 2;
	optional string message_text = 3;
}
message CDOTAUserMsg_BotChat {
	optional int32 player_id = 1;
	optional string message = 3;
	optional string target = 4;
	optional bool team_only = 5;
}
`)

// =============================================================================
// Constants & Configuration
// =============================================================================

const DEFAULT_BASE_URL = "http://217.216.74.180:20128/v1"
const DEFAULT_MODEL = "AG-Fee"
const DEFAULT_API_KEY = "sk-33db6e7caeae5447-blz40f-c7d9d9f7"
const MIN_CHAT_INTERVAL = 2.0
const RECENT_REPLY_KEEP = 8
const RESPONSE_FILE_PATH = "C:/Users/Bedjo/github.com/mm44x/example-repo/ai_bridge_response.json"
const RESPONSE_FILE_PATH_WIN = "C:\\Users\\Bedjo\\github.com\\mm44x\\example-repo\\ai_bridge_response.json"

const JUNGLE_CAMP_POS = [
	new Vector3(-3150, -800, 0),
	new Vector3(-4600, 800, 0),
	new Vector3(-2000, 2000, 0),
	new Vector3(-2000, -2000, 0),
	new Vector3(-3800, 0, 0),
	new Vector3(-5200, 1800, 0),
	new Vector3(-5200, -1800, 0),
	new Vector3(3150, 800, 0),
	new Vector3(4600, -800, 0),
	new Vector3(2000, -2000, 0),
	new Vector3(2000, 2000, 0),
	new Vector3(3800, 0, 0),
	new Vector3(5200, -1800, 0),
	new Vector3(5200, 1800, 0)
]
const JUNGLE_RADIUS = 900

interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

interface OutboxItem {
	channel: string
	text: string
	sendAt: number
}

class AIChatResponder {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("AI Chat Responder")

	// Main controls
	private readonly enabled = this.node.AddToggle("Enable", true, "Master toggle for AI Chat Responder")
	private readonly persona = this.node.AddDropdown(
		"Persona Style",
		["Chill Gamer", "Trashtalker / Savage", "SEA Pub Native", "Tryhard / Minimalist", "Funny / Clown"],
		0
	)
	private readonly replySelf = this.node.AddToggle(
		"Reply to my own chat",
		false,
		"Whether the AI should reply to your own messages"
	)
	private readonly channelMode = this.node.AddDropdown("Listen Channel", ["All chat", "Team chat", "Both"], 2)
	private readonly cooldown = this.node.AddSlider(
		"Per-player Cooldown (s)",
		2,
		0,
		30,
		0,
		"Minimum seconds before replying to the same player again"
	)
	private readonly historyCount = this.node.AddSlider(
		"Context Messages",
		30,
		5,
		100,
		0,
		"How many recent chat messages to feed as context"
	)

	// API Settings
	private readonly apiPreset = this.node.AddDropdown("API Preset", ["9router VPS", "Custom / OpenAI"], 0)
	private readonly baseUrlInput = this.node.AddTextInput("Base URL", DEFAULT_BASE_URL)
	private readonly apiKeyInput = this.node.AddTextInput("API Key", DEFAULT_API_KEY)
	private readonly modelInput = this.node.AddTextInput("Model", DEFAULT_MODEL)
	private readonly promptInput = this.node.AddTextInput("Custom Prompt (Optional)", "leave empty for default")

	// Buttons
	private readonly testBtn = this.node.AddButton("Send Test Message", "Queue a test greeting into the AI engine")
	private readonly resetPromptBtn = this.node.AddButton(
		"Clear Custom Prompt",
		"Clear custom prompt and use default built-in AI gamer rules"
	)

	// Warnings Subtree
	private readonly warnNode = this.node.AddNode("Enemy Warnings")
	private readonly warnEnabled = this.warnNode.AddToggle(
		"Enable Warnings",
		false,
		"Send automated tactical pub alerts"
	)
	private readonly warnRoshan = this.warnNode.AddToggle(
		"Warn: Enemy at Roshan",
		true,
		"Alert team when an enemy attacks Roshan"
	)
	private readonly warnSmoke = this.warnNode.AddToggle(
		"Warn: Enemy Smoked",
		true,
		"Alert team when Smoke of Deceit is used"
	)
	private readonly warnJungle = this.warnNode.AddToggle(
		"Warn: Enemy in Jungle",
		true,
		"Alert team when enemy enters our jungle out of vision"
	)
	private readonly warnCooldown = this.warnNode.AddSlider("Warning Cooldown (s)", 30, 10, 120, 0)
	private readonly warnChannel = this.warnNode.AddDropdown("Warning Channel", ["Team chat", "All chat"], 0)

	// Debug HUD
	private readonly debugHud = this.node.AddToggle(
		"Debug HUD Overlay",
		false,
		"Display bridge status and recent chat logs on screen"
	)

	// Hero Ignore Selector (dynamically populated from heroes present in the match)
	private readonly ignoreHeroSelector = this.node.AddImageSelector(
		"Ignore Heroes (No Reply)",
		[],
		new Map<string, boolean>(),
		"Select heroes in this match to ignore in chat",
		false
	)
	private lastHeroScan = 0

	// State
	private readonly lastReplyTime = new Map<number, number>()
	private readonly recentSelfReplies: string[] = []
	private readonly chatHistory: ChatMessage[] = []
	private readonly outboxQueue: OutboxItem[] = []
	private lastChatSentTime = 0
	private isRequestInProgress = false
	private requestStartTime = 0
	private pendingRequestId = 0
	private lastProcessedResponseId = 0
	private lastSmokeWarnTime = 0
	private lastRoshanWarnTime = 0
	private lastRoshanHP = 0
	private readonly warnCooldowns = new Map<number, { roshan?: number; smoke?: number; jungle?: number }>()
	private lastWarnScan = 0
	private pendingTestTrigger = false
	private pendingDispatchPayload: any = null
	private readonly hudLogs: string[] = ["AI Chat Responder initialized..."]

	constructor() {
		this.initPersistentInputs()
		this.registerEvents()
		this.setupCallbacks()
		SendToConsole("con_logfile console_ai.log")
		this.logHUD("AI Chat Responder ready (Console IPC)")
	}

	private initPersistentInputs(): void {
		const makePersistent = (input: TextInput, defaultVal: string) => {
			input.text = defaultVal
			input.SaveConfig = true
			Object.defineProperty(input, "ConfigValue", {
				get: () => input.text,
				set: (val: any) => {
					if (typeof val === "string") {
						// Filter out old multi-line prompt if cached in settings
						input.text = val.includes("You are an AI") || val.length > 200 ? "" : val
					}
				},
				configurable: true
			})
			;(input as any).DefaultValue = defaultVal
		}

		makePersistent(this.baseUrlInput, DEFAULT_BASE_URL)
		makePersistent(this.apiKeyInput, DEFAULT_API_KEY)
		makePersistent(this.modelInput, DEFAULT_MODEL)
		makePersistent(this.promptInput, "")

		// Ensure any cached large prompt is immediately cleared
		if (this.promptInput.text.includes("You are an AI") || this.promptInput.text.length > 200) {
			this.promptInput.text = ""
		}
	}

	private setupCallbacks(): void {
		this.apiPreset.OnValue(d => {
			if (d.SelectedID === 0) {
				this.baseUrlInput.text = DEFAULT_BASE_URL
				this.apiKeyInput.text = DEFAULT_API_KEY
				this.modelInput.text = DEFAULT_MODEL
			} else {
				this.baseUrlInput.text = "https://api.openai.com/v1"
				this.modelInput.text = "gpt-4o-mini"
			}
		})

		this.resetPromptBtn.OnValue(() => {
			this.promptInput.text = ""
			this.logHUD("Custom prompt cleared (using default)")
		})

		this.testBtn.OnValue(() => {
			this.logHUD("Test queued -> sending next frame")
			this.pendingTestTrigger = true
		})
	}

	private registerEvents(): void {
		Events.on("ServerMessage", this.onServerMessage.bind(this))
		EventsSDK.on("GameEvent", this.onGameEvent.bind(this))
		EventsSDK.on("ParticleCreated", this.onParticleCreated.bind(this))
		EventsSDK.on("PostDataUpdate", this.onPostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.onDraw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnd.bind(this))
		EventsSDK.on("GameStarted", this.onGameEnd.bind(this))
		EventsSDK.on("ServerInfo", this.updateMatchHeroes.bind(this))
	}

	private logHUD(msg: string): void {
		this.hudLogs.push(msg)
		if (this.hudLogs.length > 8) {
			this.hudLogs.shift()
		}
	}

	private onGameEnd(): void {
		this.lastReplyTime.clear()
		this.recentSelfReplies.length = 0
		this.chatHistory.length = 0
		this.outboxQueue.length = 0
		this.warnCooldowns.clear()
		this.isRequestInProgress = false
		this.lastChatSentTime = 0
		this.pendingRequestId = 0
		this.lastRoshanHP = 0
		this.ignoreHeroSelector.values = []
		this.ignoreHeroSelector.enabledValues.clear()
		this.ignoreHeroSelector.Update()
		this.logHUD("Match ended — state cleared")
	}

	private updateMatchHeroes(): void {
		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		if (allHeroes.length === 0) {
			return
		}

		const matchHeroNames: string[] = []
		for (const h of allHeroes) {
			if (!h || !h.IsValid || h.IsIllusion || h.IsTempestDouble || h.IsClone) {
				continue
			}
			const name = h.Name
			if (!name || !name.startsWith("npc_dota_hero_")) {
				continue
			}
			if (!matchHeroNames.includes(name)) {
				matchHeroNames.push(name)
			}
		}

		if (matchHeroNames.length === 0) {
			return
		}

		matchHeroNames.sort()

		const currentValues = this.ignoreHeroSelector.values
		const hasChanged =
			matchHeroNames.length !== currentValues.length ||
			matchHeroNames.some((val, idx) => val !== currentValues[idx])

		if (hasChanged) {
			this.ignoreHeroSelector.values = matchHeroNames
			for (const name of matchHeroNames) {
				if (!this.ignoreHeroSelector.enabledValues.has(name)) {
					this.ignoreHeroSelector.enabledValues.set(name, false)
				}
			}
			this.ignoreHeroSelector.Update()
		}
	}

	private isHeroIgnored(heroName: string): boolean {
		return this.ignoreHeroSelector.IsEnabled(heroName)
	}

	// =========================================================================
	// In-game Chat Listener
	// =========================================================================

	private onServerMessage(msgID: number, buf: ArrayBuffer): void {
		if (!this.enabled.value) {
			return
		}

		// 612 = DOTA_UM_ChatMessage (Dota 2 player chat in Source 2)
		if (msgID === 612) {
			let text = ""
			let playerId = -1
			let channelType = 0

			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CDOTAUserMsg_ChatMessage")
				text = (msg.get("message_text") as string | undefined) ?? ""
				playerId = (msg.get("source_player_id") as number | undefined) ?? -1
				channelType = (msg.get("channel_type") as number | undefined) ?? 0
			} catch {
				// Protobuf named parser failed, use binary fallback unpacker
			}

			if (!text || playerId < 0) {
				const fb = this.parseChatMessageFallback(buf)
				if (fb) {
					if (!text) {
						text = fb.text
					}
					if (playerId < 0) {
						playerId = fb.playerId
					}
					if (channelType === 0) {
						channelType = fb.channelType
					}
				}
			}

			if (text.length > 0 && playerId >= 0) {
				// channel_type 12 (DOTAChannelType_GameAllies) or 4 (DOTAChannelType_Team) is team chat
				const isTeamOnly = channelType === 12 || channelType === 4
				this.handleIncomingChat(text, playerId, isTeamOnly)
			}
		} else if (msgID === 490) {
			// 490 = DOTA_UM_BotChat
			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CDOTAUserMsg_BotChat")
				const text = (msg.get("message") as string | undefined) ?? ""
				const playerId = (msg.get("player_id") as number | undefined) ?? -1
				const isTeamOnly = Boolean(msg.get("team_only"))
				if (text.length > 0 && playerId >= 0) {
					this.handleIncomingChat(text, playerId, isTeamOnly)
				}
			} catch {
				// ignore
			}
		}
	}

	private parseChatMessageFallback(buf: ArrayBuffer): { text: string; playerId: number; channelType: number } | null {
		try {
			const bytes = new Uint8Array(buf)
			let offset = 0
			let playerId = -1
			let channelType = 0
			let text = ""

			while (offset < bytes.length) {
				let tag = 0
				let shift = 0
				while (offset < bytes.length) {
					const b = bytes[offset++]
					tag |= (b & 0x7f) << shift
					if ((b & 0x80) === 0) {
						break
					}
					shift += 7
				}

				const fieldNum = tag >>> 3
				const wireType = tag & 7

				if (wireType === 0) {
					// Varint
					let val = 0
					shift = 0
					while (offset < bytes.length) {
						const b = bytes[offset++]
						val |= (b & 0x7f) << shift
						if ((b & 0x80) === 0) {
							break
						}
						shift += 7
					}
					if (fieldNum === 1) {
						playerId = val | 0
					} else if (fieldNum === 2) {
						channelType = val | 0
					}
				} else if (wireType === 2) {
					// Length-delimited string
					let len = 0
					shift = 0
					while (offset < bytes.length) {
						const b = bytes[offset++]
						len |= (b & 0x7f) << shift
						if ((b & 0x80) === 0) {
							break
						}
						shift += 7
					}
					if (offset + len > bytes.length) {
						break
					}
					if (fieldNum === 3) {
						const stream = new ViewBinaryStream(new DataView(bytes.buffer, bytes.byteOffset + offset, len))
						text = stream.ReadUtf8String(len)
					}
					offset += len
				} else if (wireType === 1) {
					offset += 8
				} else if (wireType === 5) {
					offset += 4
				} else {
					break
				}
			}

			return { text, playerId, channelType }
		} catch {
			return null
		}
	}

	private onGameEvent(eventName: string, obj: any): void {
		if (eventName !== "player_chat" || !this.enabled.value) {
			return
		}
		const text = typeof obj.text === "string" ? obj.text : ""
		const playerId = typeof obj.playerid === "number" ? obj.playerid : -1
		const isTeamOnly = Boolean(obj.teamonly)
		this.handleIncomingChat(text, playerId, isTeamOnly)
	}

	private handleIncomingChat(rawText: string, playerId: number, isTeamOnly: boolean): void {
		if (!this.enabled.value) {
			return
		}

		const text = rawText.trim()
		if (text.length === 0 || playerId < 0) {
			return
		}

		// Filter out console commands and chat shortcuts (e.g. -ping, !pause, /laugh)
		if (/^[-!/]/.test(text)) {
			return
		}

		this.updateMatchHeroes()

		const localPlayerId = LocalPlayer?.PlayerID ?? -1
		const isSelf = playerId === localPlayerId

		// Ignore own AI echo
		if (isSelf) {
			if (!this.replySelf.value) {
				return
			}
			if (this.isOwnEcho(text)) {
				return
			}
		}

		// Filter by channel mode (0 = All, 1 = Team, 2 = Both)
		const channelMode = this.channelMode.SelectedID
		if (channelMode === 0 && isTeamOnly) {
			return
		}
		if (channelMode === 1 && !isTeamOnly) {
			return
		}

		// Speaker resolution
		const speakerData = PlayerCustomData.get(playerId)
		const speakerNick = speakerData?.PlayerName ?? `Player ${playerId}`
		const speakerHero = this.getHeroOfPlayer(playerId)
		const speakerHeroName = speakerHero ? this.cleanHeroName(speakerHero.Name) : "Player"
		const label = isSelf ? "You" : speakerHero ? `${speakerHeroName} (${speakerNick})` : speakerNick

		// Check ignored hero list
		if (speakerHero && this.isHeroIgnored(speakerHero.Name)) {
			this.logHUD(`Ignored chat from: ${speakerHeroName}`)
			return
		}

		// Check per-player cooldown
		const lastTime = this.lastReplyTime.get(playerId) ?? 0
		if (GameState.RawGameTime - lastTime < this.cooldown.value) {
			return
		}

		this.lastReplyTime.set(playerId, GameState.RawGameTime)
		this.pushHistory("user", `${label}: ${text}`)
		const chanLabel = isTeamOnly ? "Team" : "All"
		this.logHUD(`Chat [${chanLabel}] ${label}: "${text}"`)

		this.requestCompletion(isTeamOnly ? "team" : "all")
	}

	private cleanHeroName(rawName: string): string {
		return rawName.replace("npc_dota_hero_", "").replace(/_/g, " ")
	}

	private getHeroOfPlayer(playerId: number): Hero | undefined {
		const heroes = EntityManager.GetEntitiesByClass(Hero)
		return heroes.find(h => h.IsValid && h.PlayerID === playerId)
	}

	private isOwnEcho(text: string): boolean {
		return this.recentSelfReplies.includes(text)
	}

	private rememberSelfReply(text: string): void {
		this.recentSelfReplies.unshift(text)
		while (this.recentSelfReplies.length > RECENT_REPLY_KEEP) {
			this.recentSelfReplies.pop()
		}
	}

	private pushHistory(role: "user" | "assistant", content: string): void {
		this.chatHistory.push({ role, content })
		const cap = this.historyCount.value
		while (this.chatHistory.length > cap) {
			this.chatHistory.shift()
		}
	}

	// =========================================================================
	// Context Builder & Prompt Construction
	// =========================================================================

	private buildGameContext(): string {
		try {
			const localHero = LocalPlayer?.Hero
			if (!localHero || !localHero.IsValid) {
				return ""
			}

			const parts: string[] = []
			const myHeroName = this.cleanHeroName(localHero.Name)
			parts.push(`You are playing ${myHeroName}.`)

			// Condition: HP, Mana, Alive/Dead status
			if (!localHero.IsAlive) {
				const respawnSecs = Math.max(0, Math.floor(localHero.MaxRespawnDuration))
				parts.push(`Your status: DEAD (respawning in ${respawnSecs}s).`)
			} else {
				const hpPct = Math.floor((localHero.HP / Math.max(1, localHero.MaxHP)) * 100)
				const manaPct = Math.floor((localHero.Mana / Math.max(1, localHero.MaxMana)) * 100)
				parts.push(`Your status: Alive (HP: ${hpPct}%, Mana: ${manaPct}%).`)
			}

			// KDA and streak
			const myData = PlayerCustomData.get(localHero.PlayerID)
			const pTeam = myData?.PlayerTeamData
			if (pTeam) {
				const streakStr = pTeam.Streak > 2 ? ` (killstreak: ${pTeam.Streak})` : ""
				parts.push(`Your KDA: ${pTeam.Kills}/${pTeam.Deaths}/${pTeam.Assists}${streakStr}.`)
			}

			// Items in inventory
			if (localHero.HasInventory && Array.isArray(localHero.Items)) {
				const items = localHero.Items.filter(i => i && i.IsValid).map(i =>
					i.Name.replace(/^item_/, "").replace(/_/g, " ")
				)
				if (items.length > 0) {
					parts.push(`Your items: ${items.join(", ")}.`)
				}
			}

			// Allies & Enemies
			const allHeroes = EntityManager.GetEntitiesByClass(Hero)
			const allies: string[] = []
			const enemies: string[] = []

			for (const h of allHeroes) {
				if (!h.IsValid || h === localHero || h.IsIllusion || h.IsTempestDouble) {
					continue
				}
				const name = this.cleanHeroName(h.Name)
				const nick = (h.PlayerID >= 0 ? PlayerCustomData.get(h.PlayerID)?.PlayerName : undefined) ?? name
				const label = `${name} (${nick})`
				if (h.Team === localHero.Team) {
					allies.push(label)
				} else {
					enemies.push(label)
				}
			}

			if (allies.length > 0) {
				parts.push(`Allies: ${allies.join(", ")}.`)
			}
			if (enemies.length > 0) {
				parts.push(`Enemies: ${enemies.join(", ")}.`)
			}

			// Match time
			const gr = GameRules
			if (gr) {
				const rawTime = gr.GameTime
				const startTime = gr.GameStartTime
				const diff = rawTime - startTime
				if (diff < 0) {
					const s = Math.floor(Math.abs(diff))
					parts.push(`Pre-game time: -${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.`)
				} else {
					parts.push(`Game time: ${Math.floor(diff / 60)}:${String(Math.floor(diff % 60)).padStart(2, "0")}.`)
				}
			}

			return parts.join(" ")
		} catch {
			return ""
		}
	}

	// =========================================================================
	// Bridge Communication (Console Stream IPC + File Polling)
	// =========================================================================

	private requestCompletion(channel: "team" | "all"): void {
		if (this.isRequestInProgress) {
			this.logHUD("Request dropped: already in progress")
			return
		}

		const reqId = Date.now() % 100000000
		this.pendingRequestId = reqId
		this.isRequestInProgress = true
		this.requestStartTime = GameState.RawGameTime

		const payload: Record<string, any> = {
			id: reqId,
			c: channel,
			p: this.persona.SelectedID,
			ctx: this.buildGameContext(),
			h: this.chatHistory.slice(-3).map(m => ({ r: m.role, m: m.content }))
		}

		const customPrompt = this.promptInput.text.trim()
		if (customPrompt.length > 0 && !customPrompt.includes("You are an AI") && customPrompt.length <= 200) {
			payload.sys = customPrompt
		}

		this.logHUD(`Sending AI prompt via bridge (ID: ${reqId})...`)
		this.pendingDispatchPayload = payload
	}

	private toHex(str: string): string {
		const bytes: number[] = []
		for (let i = 0; i < str.length; i++) {
			let code = str.charCodeAt(i)
			if (code < 0x80) {
				bytes.push(code)
			} else if (code < 0x800) {
				bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
			} else if (code < 0xd800 || code >= 0xe000) {
				bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
			} else {
				i++
				code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff))
				bytes.push(
					0xf0 | (code >> 18),
					0x80 | ((code >> 12) & 0x3f),
					0x80 | ((code >> 6) & 0x3f),
					0x80 | (code & 0x3f)
				)
			}
		}
		let hex = ""
		for (const b of bytes) {
			hex += b.toString(16).padStart(2, "0")
		}
		return hex
	}

	private dispatchToBridge(payload: any): void {
		try {
			const jsonStr = JSON.stringify(payload)
			const hex = this.toHex(jsonStr)
			// Chunk into 32-char parts so total command length is <= 49 chars (well below 64-char Source 2 limit)
			// No spaces in command name so Dota 2 outputs 'Unknown command: aip_...' directly to console.log
			const CHUNK_SIZE = 32
			const totalParts = Math.ceil(hex.length / CHUNK_SIZE)
			for (let i = 0; i < totalParts; i++) {
				const chunk = hex.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
				SendToConsole(`aip_${payload.id}_${i + 1}_${totalParts}_${chunk}`)
			}
			this.logHUD(`Bridge: Sent ${totalParts} part(s) (${Math.round(hex.length / 2)}b)`)
		} catch (e: any) {
			this.logHUD(`Bridge error: ${e?.message ?? e}`)
		}
	}

	// =========================================================================
	// Outbox Queue & Update Loop
	// =========================================================================

	private onPostDataUpdate(): void {
		// Handle queued test button clicks on the game main thread
		if (this.pendingTestTrigger) {
			this.pendingTestTrigger = false
			this.logHUD("Test dispatched -> processing greeting")
			this.pushHistory("user", "Test (you): hello team! good luck this game")
			this.requestCompletion("team")
		}

		// Handle deferred bridge dispatch on the game main thread
		if (this.pendingDispatchPayload) {
			const payload = this.pendingDispatchPayload
			this.pendingDispatchPayload = null
			this.dispatchToBridge(payload)
		}

		// Timeout check: 20 seconds
		if (this.isRequestInProgress && GameState.RawGameTime - this.requestStartTime > 20) {
			this.isRequestInProgress = false
			this.logHUD("Request timed out after 20s")
		}

		// 1. Poll for sidecar response file
		this.pollBridgeResponse()

		// 2. Process Outbox Queue
		this.processOutbox()

		// 3. Periodic Jungle & Roshan Activity Scan
		const now = GameState.RawGameTime
		if (this.warnEnabled.value && now - this.lastWarnScan >= 0.5) {
			this.lastWarnScan = now
			this.checkRoshanActivity()
			this.checkEnemyJungleActivity()
		}

		// 4. Periodic Match Hero Scan for Ignore Selector
		if (now - this.lastHeroScan >= 1.0) {
			this.lastHeroScan = now
			this.updateMatchHeroes()
		}
	}

	private readBridgeResponse(): string | null {
		// 1. Try official wrapper readFile (searches dota VFS and scripts_files)
		try {
			const content = readFile("ai_bridge_response.json")
			if (content && content.length > 0) {
				return content
			}
		} catch {
			// ignore
		}

		// 2. Direct Source 2 VFS fread from dota root folder
		try {
			if (typeof fread === "function") {
				const content = fread("ai_bridge_response.json", false)
				if (content && typeof content === "string" && content.length > 0) {
					return content
				}
			}
		} catch {
			// ignore
		}

		// 3. Direct Source 2 VFS fread from cfg/ folder
		try {
			if (typeof fread === "function") {
				const content = fread("cfg/ai_bridge_response.json", false)
				if (content && typeof content === "string" && content.length > 0) {
					return content
				}
			}
		} catch {
			// ignore
		}

		// 4. Try scripts_files relative path
		try {
			if (typeof fread === "function") {
				const content = fread("scripts_files/ai_bridge_response.json", false)
				if (content && typeof content === "string" && content.length > 0) {
					return content
				}
			}
		} catch {
			// ignore
		}

		// 5. Direct Windows absolute paths
		try {
			if (typeof fread === "function") {
				let content = fread(RESPONSE_FILE_PATH, false)
				if (!content) {
					content = fread(RESPONSE_FILE_PATH_WIN, false)
				}
				if (content && typeof content === "string" && content.length > 0) {
					return content
				}
			}
		} catch {
			// ignore
		}

		return null
	}

	private pollBridgeResponse(): void {
		const raw = this.readBridgeResponse()
		if (!raw || raw.length === 0) {
			return
		}

		try {
			const data = JSON.parse(raw)
			if (
				!data ||
				Number(data.id) !== Number(this.pendingRequestId) ||
				Number(data.id) === Number(this.lastProcessedResponseId)
			) {
				return
			}

			this.lastProcessedResponseId = Number(data.id)
			this.isRequestInProgress = false

			if (data.status === "success" && typeof data.text === "string" && data.text.length > 0) {
				const replyText = data.text.trim()
				this.rememberSelfReply(replyText)
				this.pushHistory("assistant", replyText)
				this.logHUD(`AI reply received: "${replyText}"`)

				// Realistic typing delay: 1.2s to 2.5s
				const typingDelay = (Math.floor(Math.random() * 14) + 12) / 10
				this.outboxQueue.push({
					channel: data.channel ?? "all",
					text: replyText,
					sendAt: GameState.RawGameTime + typingDelay
				})
			} else if (data.status === "error") {
				this.logHUD(`Bridge error: ${data.error ?? "unknown"}`)
			}
		} catch {
			// File may be midway through atomic write
		}
	}

	private processOutbox(): void {
		if (this.outboxQueue.length === 0) {
			return
		}

		const now = GameState.RawGameTime
		if (now - this.lastChatSentTime < MIN_CHAT_INTERVAL) {
			return
		}

		const item = this.outboxQueue[0]
		if (now >= item.sendAt) {
			this.outboxQueue.shift()
			this.lastChatSentTime = now

			// Command injection sanitization
			const safeText = item.text
				.replace(/[\r\n;\\]/g, " ")
				.replace(/\s+/g, " ")
				.trim()
			const cmd = item.channel === "team" ? `say_team ${safeText}` : `say ${safeText}`
			GameState.ExecuteCommand(cmd)
			this.logHUD(`Sent chat -> ${cmd}`)
		}
	}

	// =========================================================================
	// Tactical Warnings (Roshan / Smoke / Jungle)
	// =========================================================================

	private checkRoshanActivity(): void {
		if (!this.warnRoshan.value) {
			return
		}

		const units = EntityManager.GetEntitiesByClass(Unit)
		const roshan = units.find(u => u.IsValid && u.IsAlive && u.IsRoshan)

		if (roshan) {
			if (this.lastRoshanHP > 0 && roshan.HP < this.lastRoshanHP) {
				const now = GameState.RawGameTime
				if (now - this.lastRoshanWarnTime >= this.warnCooldown.value) {
					this.lastRoshanWarnTime = now
					this.sendWarning("Enemy is attacking Roshan")
				}
			}
			this.lastRoshanHP = roshan.HP
		} else {
			this.lastRoshanHP = 0
		}
	}

	private onParticleCreated(particle: NetworkedParticle): void {
		if (!this.warnEnabled.value || !this.warnSmoke.value) {
			return
		}

		const path = particle.Path
		if (path.includes("smoke_of_deceit")) {
			const now = GameState.RawGameTime
			if (now - this.lastSmokeWarnTime < this.warnCooldown.value) {
				return
			}
			this.lastSmokeWarnTime = now
			this.sendWarning("Enemy has used Smoke of Deceit")
		}
	}

	private checkEnemyJungleActivity(): void {
		if (!this.warnJungle.value) {
			return
		}

		const localHero = LocalPlayer?.Hero
		if (!localHero || !localHero.IsValid) {
			return
		}

		const heroes = EntityManager.GetEntitiesByClass(Hero)
		for (const h of heroes) {
			if (!h.IsValid || !h.IsAlive || h.Team === localHero.Team || h.IsIllusion || h.IsTempestDouble) {
				continue
			}

			// Only warn when out of vision to prevent spam during normal skirmishes
			if (h.IsVisible) {
				continue
			}

			const heroPid = h.PlayerID
			const now = GameState.RawGameTime
			const cds = this.warnCooldowns.get(heroPid) ?? {}
			if (cds.jungle && now - cds.jungle < this.warnCooldown.value) {
				continue
			}

			// Check proximity to jungle camps
			for (const camp of JUNGLE_CAMP_POS) {
				if (h.Position.Distance(camp) <= JUNGLE_RADIUS) {
					cds.jungle = now
					this.warnCooldowns.set(heroPid, cds)
					const name = this.cleanHeroName(h.Name)
					this.sendWarning(`${name} is farming our jungle`)
					break
				}
			}
		}
	}

	private sendWarning(text: string): void {
		this.rememberSelfReply(text)
		const channel = this.warnChannel.SelectedID === 1 ? "all" : "team"
		this.outboxQueue.push({
			channel,
			text,
			sendAt: GameState.RawGameTime + 0.3
		})
		this.logHUD(`Warning queued: ${text}`)
	}

	// =========================================================================
	// Debug HUD Overlay
	// =========================================================================

	private onDraw(): void {
		if (!this.debugHud.value) {
			return
		}

		const startX = 25
		let startY = 180
		const width = 450
		const height = 180

		RendererSDK.FilledRect(new Vector2(startX - 5, startY - 5), new Vector2(width, height), Color.Black.SetA(200))

		RendererSDK.Text(
			"AI Chat Responder — Live Debugger",
			new Vector2(startX, startY),
			Color.Green,
			"Roboto",
			14,
			800
		)
		startY += 20

		const statusStr = this.isRequestInProgress ? "Waiting for AI reply..." : "Idle (Ready)"
		RendererSDK.Text(`Status: ${statusStr}`, new Vector2(startX, startY), new Color(0, 255, 255), "Roboto", 12, 600)
		startY += 18

		RendererSDK.Text(
			`Outbox Queue: ${this.outboxQueue.length} msg(s)`,
			new Vector2(startX, startY),
			Color.Yellow,
			"Roboto",
			12,
			600
		)
		startY += 18

		for (const log of this.hudLogs) {
			RendererSDK.Text(log, new Vector2(startX, startY), Color.White.SetA(230), "Roboto", 11, 400)
			startY += 15
		}
	}
}

export const aiChatResponder = new AIChatResponder()

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

// Register Dota 2 chat Protobuf messages
ParseProtobufDesc(`
message CUserMessageSayText {
	optional int32 playerindex = 1 [default = -1];
	optional string text = 2;
	optional bool chat = 3;
}
message CUserMessageSayText2 {
	optional int32 entityindex = 1 [default = -1];
	optional bool chat = 2;
	optional string messagename = 3;
	optional string param1 = 4;
	optional string param2 = 5;
	optional string param3 = 6;
	optional string param4 = 7;
}
message CUserMessageSayTextChannel {
	optional int32 player = 1;
	optional int32 channel = 2;
	optional string text = 3;
}
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
		true,
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
	private requestStartTimeMs = 0
	private pendingRequestId = 0
	private lastProcessedResponseId = 0
	private lastSmokeWarnTime = 0
	private lastRoshanWarnTime = 0
	private lastRoshanHP = 0
	private readonly warnCooldowns = new Map<number, { roshan?: number; smoke?: number; jungle?: number }>()
	private lastWarnScan = 0
	private pendingTestTrigger = false
	private pendingDispatchPayload: any = null
	private readonly pendingConsoleQueue: string[] = []
	private readonly hudLogs: string[] = ["AI Chat Responder initialized..."]
	private static readonly IGNORED_NET_IDS = new Set([
		4, // CNETMsg_Tick
		40, // CSVCMsg_ServerInfo
		41, // CSVCMsg_SendTable
		45, // CSVCMsg_UpdateStringTable
		51, // CSVCMsg_RemoveAllStringTables
		55, // CSVCMsg_PacketEntities
		145, // CUserMsg_ParticleManager
		208, // CMsgSosStartSoundEvent
		488, // CDOTAUserMsg_UnitEvent
		489, // CDOTAUserMsg_ParticleManager
		521, // CDOTAUserMsg_TE_UnitAnimation
		522 // CDOTAUserMsg_TE_UnitAnimationEnd
	])
	private readonly recentNetMsgIDs: number[] = []
	private netMsgCount = 0
	private lastNetMsgStr = "Waiting for packets..."
	private lastProcessedChatText = ""
	private lastProcessedChatTime = 0
	private lastPanoramaChildCount = -1
	private lastPanoramaLineText = ""
	private lastHookedPanelId = "Searching..."
	private lastPanoChildCount = 0
	private panoramaChatHooked = false
	private lastPanoPollTime = 0

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
		Events.on("CustomGameEvent", this.onCustomGameEvent.bind(this))
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
		this.requestStartTimeMs = 0
		this.pendingConsoleQueue.length = 0
		this.lastChatSentTime = 0
		this.pendingRequestId = 0
		this.lastRoshanHP = 0
		this.lastPanoramaChildCount = -1
		this.lastPanoramaLineText = ""
		this.lastProcessedChatText = ""
		this.lastProcessedChatTime = 0
		this.panoramaChatHooked = false
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
		this.netMsgCount++

		if (!AIChatResponder.IGNORED_NET_IDS.has(msgID)) {
			this.lastNetMsgStr = `ID ${msgID} (${buf.byteLength}b)`
			if (!this.recentNetMsgIDs.includes(msgID)) {
				this.recentNetMsgIDs.push(msgID)
				if (this.recentNetMsgIDs.length > 6) {
					this.recentNetMsgIDs.shift()
				}
			}
		}

		if (!this.enabled.value) {
			return
		}

		// 1. CUserMessageSayText2 (ID 118) - Source 2 Player Chat
		if (msgID === 118) {
			let text = ""
			let sender = ""
			let playerId = -1
			let isTeamOnly = false

			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CUserMessageSayText2")
				const msgName = (msg.get("messagename") as string | undefined) ?? ""
				sender = (msg.get("param1") as string | undefined) ?? ""
				text = (msg.get("param2") as string | undefined) ?? ""
				playerId = (msg.get("entityindex") as number | undefined) ?? -1
				isTeamOnly = msgName.toLowerCase().includes("allies") || msgName.toLowerCase().includes("team")
			} catch {
				// Protobuf named parser failed, use binary fallback
			}

			if (!text) {
				const fb = this.parseSayText2Fallback(buf)
				if (fb) {
					text = fb.text
					sender = fb.sender
					playerId = fb.playerId
					isTeamOnly = fb.isTeamOnly
				}
			}

			if (text.length > 0) {
				if (playerId < 0) {
					playerId = LocalPlayer?.PlayerID ?? 0
				}
				this.logHUD(`[SayText2] <${sender || "Player"}>: "${text}"`)
				this.handleIncomingChat(text, playerId, isTeamOnly, sender)
				return
			}
		}

		// 2. CUserMessageSayText (ID 117)
		if (msgID === 117) {
			let text = ""
			let playerId = -1
			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CUserMessageSayText")
				text = (msg.get("text") as string | undefined) ?? ""
				playerId = (msg.get("playerindex") as number | undefined) ?? -1
			} catch {
				// fallback
			}
			if (text.length > 0) {
				if (playerId < 0) {
					playerId = LocalPlayer?.PlayerID ?? 0
				}
				this.logHUD(`[SayText] "${text}"`)
				this.handleIncomingChat(text, playerId, false)
				return
			}
		}

		// 3. CUserMessageSayTextChannel (ID 119)
		if (msgID === 119) {
			let text = ""
			let playerId = -1
			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CUserMessageSayTextChannel")
				text = (msg.get("text") as string | undefined) ?? ""
				playerId = (msg.get("player") as number | undefined) ?? -1
			} catch {
				// fallback
			}
			if (text.length > 0) {
				if (playerId < 0) {
					playerId = LocalPlayer?.PlayerID ?? 0
				}
				this.logHUD(`[SayTextChannel] "${text}"`)
				this.handleIncomingChat(text, playerId, false)
				return
			}
		}

		// 4. DOTA_UM_ChatMessage (ID 612)
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
				// fallback
			}

			if (!text) {
				const fb = this.parseChatMessageFallback(buf)
				if (fb) {
					text = fb.text
					playerId = fb.playerId
					channelType = fb.channelType
				}
			}

			if (text.length > 0) {
				if (playerId < 0) {
					playerId = LocalPlayer?.PlayerID ?? 0
				}
				const isTeamOnly = channelType === 12 || channelType === 4
				this.logHUD(`[Net 612] "${text}"`)
				this.handleIncomingChat(text, playerId, isTeamOnly)
				return
			}
		}

		// 5. DOTA_UM_BotChat (ID 490)
		if (msgID === 490) {
			try {
				const msg = ParseProtobufNamed(new Uint8Array(buf), "CDOTAUserMsg_BotChat")
				const text = (msg.get("message") as string | undefined) ?? ""
				const playerId = (msg.get("player_id") as number | undefined) ?? -1
				const isTeamOnly = Boolean(msg.get("team_only"))
				if (text.length > 0) {
					this.logHUD(`[Bot 490] "${text}"`)
					this.handleIncomingChat(text, playerId < 0 ? LocalPlayer?.PlayerID ?? 0 : playerId, isTeamOnly)
					return
				}
			} catch {
				// ignore
			}
		}

		// 6. Generic scanner fallback for any unknown packet carrying chat
		if (!AIChatResponder.IGNORED_NET_IDS.has(msgID)) {
			const found = this.findReadableString(buf)
			if (
				found &&
				found.length >= 2 &&
				!found.startsWith("npc_dota_") &&
				!found.startsWith("models/") &&
				!found.startsWith("particles/") &&
				!found.startsWith("sounds/") &&
				!found.startsWith("#")
			) {
				this.logHUD(`[Net ${msgID}] "${found}"`)
				this.handleIncomingChat(found, LocalPlayer?.PlayerID ?? 0, true)
			}
		}
	}

	private parseSayText2Fallback(
		buf: ArrayBuffer
	): { text: string; sender: string; playerId: number; isTeamOnly: boolean } | null {
		try {
			const bytes = new Uint8Array(buf)
			let offset = 0
			let playerId = -1
			let msgName = ""
			let sender = ""
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
					}
				} else if (wireType === 2) {
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
					if (len > 0 && len < 500) {
						const stream = new ViewBinaryStream(new DataView(bytes.buffer, bytes.byteOffset + offset, len))
						const str = stream.ReadUtf8String(len)
						if (str && str.length > 0) {
							if (fieldNum === 3) {
								msgName = str
							} else if (fieldNum === 4) {
								sender = str
							} else if (fieldNum === 5) {
								text = str
							}
						}
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

			if (text.length > 0) {
				const isTeamOnly = msgName.toLowerCase().includes("allies") || msgName.toLowerCase().includes("team")
				return { text, sender, playerId, isTeamOnly }
			}
			return null
		} catch {
			return null
		}
	}

	private findReadableString(buf: ArrayBuffer): string | null {
		try {
			const bytes = new Uint8Array(buf)
			let offset = 0
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
				const wireType = tag & 7
				if (wireType === 0) {
					while (offset < bytes.length && (bytes[offset++] & 0x80) !== 0) {
						// skip varint
					}
				} else if (wireType === 2) {
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
					if (len >= 2 && len < 300 && offset + len <= bytes.length) {
						const stream = new ViewBinaryStream(new DataView(bytes.buffer, bytes.byteOffset + offset, len))
						const s = stream.ReadUtf8String(len)
						if (s && s.length >= 2 && /^[\x20-\x7E\u00A0-\uFFFF]+$/.test(s)) {
							return s
						}
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
		} catch {
			// ignore
		}
		return null
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
					if (fieldNum === 3 || (!text && len > 0 && len < 500)) {
						const stream = new ViewBinaryStream(new DataView(bytes.buffer, bytes.byteOffset + offset, len))
						const extracted = stream.ReadUtf8String(len)
						if (extracted && extracted.length > 0) {
							text = extracted
						}
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

	// =========================================================================
	// Panorama Chat Integration
	// =========================================================================

	private getPanelText(p: any): string {
		if (!p) {
			return ""
		}
		try {
			if (typeof p.GetText === "function") {
				const val = p.GetText()
				if (typeof val === "string" && val.trim().length > 0) {
					return val.trim()
				}
			}
		} catch {
			// ignore
		}
		try {
			if (typeof p.text === "string" && p.text.trim().length > 0) {
				return p.text.trim()
			}
		} catch {
			// ignore
		}
		try {
			if (typeof p.textLabel === "string" && p.textLabel.trim().length > 0) {
				return p.textLabel.trim()
			}
		} catch {
			// ignore
		}
		try {
			if (
				typeof p.GetAttribute === "function" &&
				typeof Panorama !== "undefined" &&
				typeof Panorama.MakeSymbol === "function"
			) {
				const symText = Panorama.MakeSymbol("text")
				const valText = p.GetAttribute(symText, "")
				if (typeof valText === "string" && valText.trim().length > 0) {
					return valText.trim()
				}
				const symHtml = Panorama.MakeSymbol("html")
				const valHtml = p.GetAttribute(symHtml, "")
				if (typeof valHtml === "string" && valHtml.trim().length > 0) {
					return valHtml.trim()
				}
			}
		} catch {
			// ignore
		}
		return ""
	}

	private findBestChatPanel(hud: IUIPanel): IUIPanel | null {
		const candidates = [
			hud.FindChildTraverse("ChatLinesPanel"),
			hud.FindChildTraverse("ChatLinesWrapper"),
			hud.FindChildTraverse("ChatLinesContainer"),
			hud.FindChildTraverse("ChatLines"),
			hud.FindChildTraverse("ChatHistory"),
			hud.FindChildTraverse("HudChat")
		]
		for (const p of candidates) {
			if (p) {
				try {
					const c = Number(p.GetChildCount?.() ?? 0)
					if (c > 0) {
						return p
					}
				} catch {
					// ignore
				}
			}
		}
		for (const p of candidates) {
			if (p) {
				return p
			}
		}
		return null
	}

	private pollPanoramaChat(): void {
		if (!this.enabled.value || !GameState.IsConnected) {
			return
		}
		try {
			if (typeof Panorama === "undefined" || !Panorama || typeof Panorama.FindRootPanel !== "function") {
				return
			}
			const hud = Panorama.FindRootPanel("DotaHud")
			if (!hud) {
				return
			}

			const chatPanel = this.findBestChatPanel(hud)
			if (!chatPanel) {
				return
			}

			this.lastHookedPanelId = chatPanel.GetID() || "ChatPanel"
			if (!this.panoramaChatHooked) {
				this.panoramaChatHooked = true
				this.logHUD(`Panorama chat linked: ${this.lastHookedPanelId}`)
			}

			const childCount = Number(chatPanel.GetChildCount?.() ?? 0)
			this.lastPanoChildCount = childCount
			if (childCount === 0) {
				this.lastPanoramaChildCount = 0
				this.lastPanoramaLineText = ""
				return
			}

			const lastChild = chatPanel.GetLastChild?.() ?? (childCount > 0 ? chatPanel.GetChild(childCount - 1) : null)
			if (!lastChild) {
				return
			}

			const fullText = this.extractPanelText(lastChild)
			if (!fullText || fullText.length === 0) {
				return
			}

			if (this.lastPanoramaLineText === "") {
				// Initial hook: if a message is already on screen, process it immediately!
				this.lastPanoramaLineText = fullText
				this.lastPanoramaChildCount = childCount
				this.logHUD(`[Pano Read] "${fullText}"`)
				this.processPanoramaChatLine(fullText)
			} else if (fullText !== this.lastPanoramaLineText || childCount !== this.lastPanoramaChildCount) {
				this.lastPanoramaLineText = fullText
				this.lastPanoramaChildCount = childCount
				this.processPanoramaChatLine(fullText)
			}
		} catch {
			// ignore
		}
	}

	private extractPanelText(panel: Nullable<IUIPanel>): string {
		if (!panel) {
			return ""
		}
		const parts: string[] = []
		const walk = (p: IUIPanel, depth: number) => {
			if (depth > 6) {
				return
			}
			const t = this.getPanelText(p)
			if (t && t.length > 0) {
				parts.push(t)
			}
			try {
				const count = Number(p.GetChildCount?.() ?? 0)
				for (let i = 0; i < count; i++) {
					const child = p.GetChild(i)
					if (child) {
						walk(child, depth + 1)
					}
				}
			} catch {
				// ignore
			}
		}
		walk(panel, 0)
		return parts.join(" ").trim()
	}

	private processPanoramaChatLine(rawLine: string): void {
		// Strip HTML markup (e.g. <font color="...">...</font>) and clean whitespace
		const line = rawLine.replace(/<[^>]*>/g, "").trim()
		if (!line || line.length < 2) {
			return
		}

		if (this.isOwnEcho(line)) {
			return
		}

		let isTeamOnly = false
		let remaining = line
		const chanMatch = line.match(/^\[(Allies|Team|All|Whisper|Party)\]\s*(.*)$/i)
		if (chanMatch) {
			const tag = chanMatch[1].toLowerCase()
			isTeamOnly = tag === "allies" || tag === "team"
			remaining = chanMatch[2]
		}

		let senderName = ""
		let messageText = ""
		const colonIdx = remaining.indexOf(":")
		if (colonIdx > 0) {
			senderName = remaining.slice(0, colonIdx).trim()
			messageText = remaining.slice(colonIdx + 1).trim()
		} else {
			senderName = "Player"
			messageText = remaining.trim()
		}

		if (!messageText || messageText.length === 0) {
			return
		}

		this.logHUD(`[Panorama] <${senderName || "Unknown"}>: "${messageText}"`)

		let playerId = -1
		if (senderName && senderName !== "Player") {
			const playerCustomData = PlayerCustomData.Array
			for (const p of playerCustomData) {
				if (p && p.PlayerName && p.PlayerName.trim().toLowerCase() === senderName.toLowerCase()) {
					playerId = p.PlayerID
					break
				}
			}
		}
		if (playerId < 0) {
			playerId = LocalPlayer?.PlayerID ?? 0
		}

		this.handleIncomingChat(messageText, playerId, isTeamOnly, senderName)
	}

	// =========================================================================
	// Game Event Fallback
	// =========================================================================

	private onGameEvent(eventName: string, obj: any): void {
		if (!this.enabled.value) {
			return
		}
		if (eventName.toLowerCase().includes("chat")) {
			this.logHUD(`[GameEvent: ${eventName}]`)
		}
		if (obj && typeof obj === "object") {
			const text = typeof obj.text === "string" ? obj.text : typeof obj.message === "string" ? obj.message : ""
			if (text.length > 0) {
				const playerId =
					typeof obj.playerid === "number"
						? obj.playerid
						: typeof obj.player_id === "number"
						? obj.player_id
						: LocalPlayer?.PlayerID ?? 0
				const isTeamOnly = Boolean(obj.teamonly ?? obj.team_only)
				this.logHUD(`[GameEvent ${eventName}] "${text}"`)
				this.handleIncomingChat(text, playerId, isTeamOnly)
			}
		}
	}

	private onCustomGameEvent(eventName: string, data: any): void {
		if (!this.enabled.value) {
			return
		}
		if (data && typeof data === "object") {
			for (const key of Object.keys(data)) {
				const val = data[key]
				if (typeof val === "string" && val.length > 0 && val.length < 200) {
					this.logHUD(`[CustomEvent ${eventName}] "${val}"`)
					this.handleIncomingChat(val, LocalPlayer?.PlayerID ?? 0, false)
					return
				}
			}
		}
	}

	private handleIncomingChat(rawText: string, playerId: number, isTeamOnly: boolean, senderName?: string): void {
		if (!this.enabled.value) {
			return
		}

		const text = rawText.trim()
		if (text.length === 0) {
			return
		}

		// Filter out console commands and chat shortcuts (e.g. -ping, !pause, /laugh)
		if (/^[-!/]/.test(text)) {
			return
		}

		// Filter out raw localization strings e.g. #Dota_Chat_...
		if (text.startsWith("#")) {
			return
		}

		// Deduplication across multiple hooks (e.g. NetMessage + Panorama UI + GameEvent)
		const now = GameState.RawGameTime
		if (
			text.toLowerCase() === this.lastProcessedChatText.toLowerCase() &&
			Math.abs(now - this.lastProcessedChatTime) < 1.0
		) {
			return
		}
		this.lastProcessedChatText = text
		this.lastProcessedChatTime = now

		this.updateMatchHeroes()

		if (playerId < 0) {
			playerId = LocalPlayer?.PlayerID ?? 0
		}

		const localPlayerId = LocalPlayer?.PlayerID ?? 0
		const isSelf = playerId === localPlayerId

		// Speaker resolution
		const speakerData = PlayerCustomData.get(playerId)
		const speakerNick = speakerData?.PlayerName ?? senderName ?? (isSelf ? "You" : `Player ${playerId}`)
		const speakerHero = this.getHeroOfPlayer(playerId)
		const speakerHeroName = speakerHero ? this.cleanHeroName(speakerHero.Name) : senderName || "Player"
		const label = isSelf ? "You" : speakerHero ? `${speakerHeroName} (${speakerNick})` : speakerNick
		const chanLabel = isTeamOnly ? "Team" : "All"

		// Demo mode detection
		const heroes = EntityManager.GetEntitiesByClass(Hero).filter(h => h.IsValid && !h.IsIllusion)
		const isDemoMode = heroes.length <= 1

		// Ignore own AI echo
		if (isSelf) {
			if (!this.replySelf.value && !isDemoMode) {
				this.logHUD(`Drop self chat ("${text}") [Enable 'Reply to my own chat']`)
				return
			}
			if (this.isOwnEcho(text)) {
				this.logHUD(`Drop AI echo ("${text}")`)
				return
			}
		}

		// Filter by channel mode (0 = All, 1 = Team, 2 = Both) - Bypassed in Demo Mode
		if (!isDemoMode) {
			const channelMode = this.channelMode.SelectedID
			if (channelMode === 0 && isTeamOnly) {
				this.logHUD("Drop chat: channel mode blocks Team")
				return
			}
			if (channelMode === 1 && !isTeamOnly) {
				this.logHUD("Drop chat: channel mode blocks All")
				return
			}
		}

		// Check ignored hero list
		if (speakerHero && this.isHeroIgnored(speakerHero.Name)) {
			this.logHUD(`Ignored chat from: ${speakerHeroName}`)
			return
		}

		// Check per-player cooldown
		const lastTime = this.lastReplyTime.get(playerId) ?? 0
		if (now - lastTime < this.cooldown.value) {
			this.logHUD(`Cooldown active for ${speakerHeroName}`)
			return
		}

		this.lastReplyTime.set(playerId, now)
		this.pushHistory("user", `${label}: ${text}`)
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
		const clean = text.trim().toLowerCase()
		return this.recentSelfReplies.some(r => {
			const rClean = r.trim().toLowerCase()
			return clean === rClean || clean.includes(rClean) || rClean.includes(clean)
		})
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

			// Items in inventory (main 6)
			if (localHero.HasInventory && Array.isArray(localHero.Items)) {
				const items = localHero.Items.filter(i => i && i.IsValid)
					.slice(0, 6)
					.map(i => i.Name.replace(/^item_/, "").replace(/_/g, " "))
				if (items.length > 0) {
					parts.push(`Your items: ${items.join(", ")}.`)
				}
			}

			// Allies & Enemies (compact hero names)
			const allHeroes = EntityManager.GetEntitiesByClass(Hero)
			const allies: string[] = []
			const enemies: string[] = []

			for (const h of allHeroes) {
				if (!h.IsValid || h === localHero || h.IsIllusion || h.IsTempestDouble) {
					continue
				}
				const name = this.cleanHeroName(h.Name)
				if (h.Team === localHero.Team) {
					allies.push(name)
				} else {
					enemies.push(name)
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
		this.requestStartTimeMs = Date.now()

		const payload: Record<string, any> = {
			id: reqId,
			c: channel,
			p: this.persona.SelectedID,
			ctx: this.buildGameContext(),
			h: this.chatHistory.slice(-2).map(m => ({ r: m.role, m: m.content }))
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
			// Chunk into 80-char parts (~100 chars total command length, well within Source 2 limit)
			// No spaces in command name so Dota 2 outputs 'Unknown command: aip_...' directly to console.log
			const CHUNK_SIZE = 80
			const totalParts = Math.ceil(hex.length / CHUNK_SIZE)
			for (let i = 0; i < totalParts; i++) {
				const chunk = hex.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
				this.pendingConsoleQueue.push(`aip_${payload.id}_${i + 1}_${totalParts}_${chunk}`)
			}
			this.logHUD(`Bridge: Queued ${totalParts} part(s) (${Math.round(hex.length / 2)}b)`)
		} catch (e: any) {
			this.logHUD(`Bridge error: ${e?.message ?? e}`)
		}
	}

	// =========================================================================
	// Outbox Queue & Update Loop
	// =========================================================================

	private onPostDataUpdate(): void {
		if (!this.enabled.value || !GameState.IsConnected) {
			return
		}

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

		// Wall-clock timeout check: 15 seconds
		if (this.isRequestInProgress && Date.now() - this.requestStartTimeMs > 15000) {
			this.isRequestInProgress = false
			this.pendingConsoleQueue.length = 0
			this.logHUD("Request timed out after 15s")
		}

		// Dispatch up to 6 console command parts per tick to prevent Source 2 command buffer overflow
		if (this.pendingConsoleQueue.length > 0) {
			const batchSize = Math.min(6, this.pendingConsoleQueue.length)
			for (let i = 0; i < batchSize; i++) {
				const cmd = this.pendingConsoleQueue.shift()
				if (cmd) {
					SendToConsole(cmd)
				}
			}
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

		// 5. Poll Panorama Chat Lines (Throttled to 250ms)
		if (now - this.lastPanoPollTime >= 0.25) {
			this.lastPanoPollTime = now
			this.pollPanoramaChat()
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
		if (!this.debugHud.value || !GameState.IsConnected) {
			return
		}

		const startX = 25
		let startY = 180
		const width = 500
		const height = 230

		RendererSDK.FilledRect(new Vector2(startX - 5, startY - 5), new Vector2(width, height), Color.Black.SetA(210))

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

		const recNetStr = this.recentNetMsgIDs.length > 0 ? this.recentNetMsgIDs.join(", ") : "None"
		RendererSDK.Text(
			`Packets: ${this.netMsgCount} msgs | ${this.lastNetMsgStr} | Rec: [${recNetStr}]`,
			new Vector2(startX, startY),
			Color.Yellow,
			"Roboto",
			11,
			500
		)
		startY += 16

		const panoStatus = this.panoramaChatHooked ? "HOOKED" : "Searching..."
		const lastTxtPreview = this.lastPanoramaLineText ? `"${this.lastPanoramaLineText.slice(0, 24)}"` : "none"
		RendererSDK.Text(
			`Pano: ${this.lastHookedPanelId} (${this.lastPanoChildCount} ch) | Last: ${lastTxtPreview}`,
			new Vector2(startX, startY),
			new Color(255, 200, 100),
			"Roboto",
			11,
			500
		)
		startY += 16

		RendererSDK.Text(
			`Outbox: ${this.outboxQueue.length} msg(s) | ReplySelf: ${
				this.replySelf.value ? "ON" : "OFF"
			} | Pano: ${panoStatus}`,
			new Vector2(startX, startY),
			new Color(150, 220, 255),
			"Roboto",
			11,
			500
		)
		startY += 18

		for (const log of this.hudLogs) {
			RendererSDK.Text(log, new Vector2(startX, startY), Color.White.SetA(230), "Roboto", 11, 400)
			startY += 15
		}
	}
}

export const aiChatResponder = new AIChatResponder()

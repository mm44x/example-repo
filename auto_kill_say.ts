import {
	EntityManager,
	EventsSDK,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	PlayerCustomData,
	Unit
} from "github.com/octarine-public/wrapper/index"

/* eslint-disable @typescript-eslint/naming-convention */
interface IEntityKilledEvent {
	entindex_killed: number
	entindex_attacker: number
	entindex_inflictor: number
	damagebits: number
	server_tick: number
}
/* eslint-enable @typescript-eslint/naming-convention */

interface PendingChat {
	command: string
	sendTime: number
}

new (class AutoKillSay {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode(
		"Auto Kill Say",
		"auto_kill_say",
		"Automatically send a chat message when an enemy hero dies"
	)

	// Menu options
	private readonly enabled = this.node.AddToggle("Enabled", true, "Enable or disable Auto Kill Say")

	private readonly chatChannel = this.node.AddDropdown(
		"Chat Channel",
		["All Chat", "Team Chat"],
		0,
		"Target channel to send the chat message"
	)

	private readonly triggerOn = this.node.AddDropdown(
		"Trigger On",
		["Only My Kills", "Any Enemy Death"],
		0,
		"Trigger only when you/your units get the kill, or on any enemy hero death"
	)

	private readonly messagePreset = this.node.AddDropdown(
		"Message Preset",
		["Custom Message", "GG", "EZ", "ez mid", "Well played!", "?"],
		0,
		"Select a preset message or choose Custom Message to use your own text"
	)

	private readonly customMessage = this.node.AddTextInput("Custom Message", "GG", 0)

	private readonly ignoreReincarnation = this.node.AddToggle(
		"Ignore Aegis / Reincarnation",
		true,
		"Do not chat if the enemy has Aegis of the Immortal or WK Reincarnation ready"
	)

	private readonly chatDelay = this.node.AddSlider(
		"Chat Delay (ms)",
		300,
		0,
		2000,
		0,
		"Delay in milliseconds before sending chat to look natural"
	)

	private readonly cooldown = this.node.AddSlider(
		"Cooldown (sec)",
		3,
		1,
		15,
		0,
		"Minimum interval between messages to avoid Dota 2 chat flood bans"
	)

	// Runtime state tracking
	private readonly deadHeroIndices = new Set<number>()
	private readonly wasReincarnateReady = new Map<number, boolean>()
	private pendingChat: PendingChat | undefined
	private lastMessageTime = 0

	constructor() {
		// Initialize customMessage config persistence and default value
		this.customMessage.text = "GG"
		this.customMessage.SaveConfig = true
		Object.defineProperty(this.customMessage, "ConfigValue", {
			get: () => this.customMessage.text,
			set: (val: any) => {
				if (typeof val === "string") {
					this.customMessage.text = val
				}
			},
			configurable: true
		})
		;(this.customMessage as any).DefaultValue = "GG"
		;(this.customMessage as any).ResetConfigValue = () => {
			this.customMessage.text = "GG"
		}

		// Toggle customMessage visibility based on preset selection
		this.messagePreset.OnValue(p => {
			this.customMessage.IsHidden = p.SelectedID !== 0
		})

		EventsSDK.on("GameEvent", this.GameEvent.bind(this))
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
		EventsSDK.on("GameStarted", this.GameEnded.bind(this))
	}

	private GameEvent(name: string, obj: any): void {
		if (name !== "entity_killed" || !this.enabled.value) {
			return
		}

		const localHero = LocalPlayer?.Hero
		if (!localHero || !localHero.IsValid) {
			return
		}

		const event = obj as IEntityKilledEvent
		const victim = EntityManager.EntityByIndex(event.entindex_killed)
		if (!(victim instanceof Hero) || !victim.IsValid) {
			return
		}

		// Ensure victim is an enemy hero
		if (!victim.IsEnemy(localHero)) {
			return
		}

		// Ensure victim is a real hero (filter out illusions and clones)
		if (!this.isRealEnemyHero(victim)) {
			return
		}

		// Ignore if victim has Aegis or WK Reincarnation ready
		if (
			this.ignoreReincarnation.value &&
			(victim.CanReincarnate || this.wasReincarnateReady.get(victim.Index) === true)
		) {
			return
		}

		// Prevent duplicate processing during the same death cycle
		if (this.deadHeroIndices.has(victim.Index)) {
			return
		}
		this.deadHeroIndices.add(victim.Index)

		// Check kill attribution if "Only My Kills" is selected
		const attacker = EntityManager.EntityByIndex(event.entindex_attacker)
		const isMyKill = this.checkIsMyKill(attacker, localHero)
		if (this.triggerOn.SelectedID === 0 && !isMyKill) {
			return
		}

		// Check cooldown
		const now = GameState.RawGameTime
		if (now - this.lastMessageTime < this.cooldown.value) {
			return
		}

		// Resolve chat message
		const message = this.resolveMessage(victim, localHero)
		if (!message || message.length === 0) {
			return
		}

		const channel = this.chatChannel.SelectedID === 0 ? "say" : "say_team"
		const delaySec = this.chatDelay.value / 1000

		this.lastMessageTime = now + delaySec

		if (delaySec <= 0.01) {
			GameState.ExecuteCommand(`${channel} ${message}`)
		} else {
			this.pendingChat = {
				command: `${channel} ${message}`,
				sendTime: now + delaySec
			}
		}
	}

	private PostDataUpdate(): void {
		const localHero = LocalPlayer?.Hero
		if (!localHero || !localHero.IsValid) {
			return
		}

		// Track reincarnation readiness and handle hero respawns
		for (const hero of EntityManager.GetEntitiesByClass(Hero)) {
			if (!hero || !hero.IsValid) {
				continue
			}
			if (hero.IsAlive) {
				// Hero is alive again -> remove from dead tracking set so next death can be handled
				if (this.deadHeroIndices.has(hero.Index)) {
					this.deadHeroIndices.delete(hero.Index)
				}
				if (hero.IsEnemy(localHero) && !hero.IsIllusion) {
					this.wasReincarnateReady.set(hero.Index, hero.CanReincarnate)
				}
			}
		}

		// Dispatch pending delayed chat message
		if (this.pendingChat !== undefined && GameState.RawGameTime >= this.pendingChat.sendTime) {
			GameState.ExecuteCommand(this.pendingChat.command)
			this.pendingChat = undefined
		}
	}

	private isRealEnemyHero(hero: Hero): boolean {
		if (!hero || !hero.IsValid) {
			return false
		}
		if (hero.IsIllusion || hero.IsTempestDouble) {
			return false
		}
		if (hero.Name === "npc_dota_hero_phantom_lancer") {
			const hasIllusionBuff = hero.Buffs.some(
				b =>
					b &&
					b.IsValid &&
					(b.Name === "modifier_phantom_lancer_juxtapose_illusion" ||
						b.Name === "modifier_phantom_lancer_juxtapose_illusion_uncontrollable" ||
						b.Name === "modifier_phantom_lancer_doppelwalk_illusion" ||
						b.Name === "modifier_illusion")
			)
			if (hasIllusionBuff) {
				return false
			}
		}
		return true
	}

	private checkIsMyKill(attacker: any, localHero: Hero): boolean {
		if (!attacker || !localHero) {
			return false
		}
		if (attacker === localHero) {
			return true
		}
		if (attacker.Owner === localHero || attacker.RootOwner === localHero) {
			return true
		}
		if (attacker instanceof Unit) {
			if (attacker.IsControllable) {
				return true
			}
			const playerId = LocalPlayer?.PlayerID
			if (playerId !== undefined && playerId >= 0) {
				if (attacker.PlayerID === playerId || attacker.OwnerPlayerID === playerId) {
					return true
				}
			}
		}
		return false
	}

	private resolveMessage(victim: Hero, localHero: Hero): string {
		let rawText: string
		if (this.messagePreset.SelectedID === 0) {
			rawText = this.customMessage.text.trim()
			if (rawText.length === 0) {
				rawText = "GG"
			}
		} else {
			rawText = this.messagePreset.ValuesNames[this.messagePreset.SelectedID]
		}

		// If multiple phrases separated by '|', pick one randomly
		if (rawText.includes("|")) {
			const options = rawText
				.split("|")
				.map(s => s.trim())
				.filter(s => s.length > 0)
			if (options.length > 0) {
				rawText = options[Math.floor(Math.random() * options.length)]
			}
		}

		// Format dynamic placeholders
		const victimHeroName = this.formatHeroName(victim.Name)
		const victimPlayerName =
			(victim.PlayerID >= 0 ? PlayerCustomData.get(victim.PlayerID)?.PlayerName : undefined) ?? victimHeroName
		const killerHeroName = this.formatHeroName(localHero.Name)

		let finalMsg = rawText
			.replace(/\{victim\}/gi, victimHeroName)
			.replace(/\{hero\}/gi, victimHeroName)
			.replace(/\{player\}/gi, victimPlayerName)
			.replace(/\{killer\}/gi, killerHeroName)

		// Sanitize string to prevent command injection or broken console syntax
		finalMsg = finalMsg
			.replace(/[\r\n;\\]/g, " ")
			.replace(/\s+/g, " ")
			.trim()

		return finalMsg
	}

	private formatHeroName(heroName: string): string {
		return heroName
			.replace("npc_dota_hero_", "")
			.split("_")
			.map(w => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ")
	}

	private GameEnded(): void {
		this.deadHeroIndices.clear()
		this.wasReincarnateReady.clear()
		this.pendingChat = undefined
		this.lastMessageTime = 0
	}
})()

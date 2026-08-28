import {
	Attributes,
	Color,
	DOTACustomHeroPickRulesPhase,
	DOTAGameMode,
	DOTAGameState,
	EventsSDK,
	GameRules,
	GameState,
	Menu,
	RendererSDK,
	TickSleeper,
	TurboHeroPickRules,
	UnitData,
	Vector2
} from "github.com/octarine-public/wrapper/index"

new (class AutoBanUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly tree = this.entry.AddNode("Auto Ban Heroes")
	private readonly enabled = this.tree.AddToggle("Enabled", true, "Master ON/OFF toggle for Auto Ban")
	private readonly banStrategy = this.tree.AddDropdown(
		"Ban Strategy",
		["Ban First Available", "Ban All Selected (Turbo/Custom)", "Random From Selected"],
		1,
		"How to prioritize bans when multiple heroes are selected"
	)
	private readonly debugToggle = this.tree.AddToggle(
		"Debug Draw",
		false,
		"Display drafting & ban state on screen",
		10
	)

	private readonly strengthNode = this.tree.AddNode("Strength Heroes")
	private readonly agilityNode = this.tree.AddNode("Agility Heroes")
	private readonly intellectNode = this.tree.AddNode("Intelligence Heroes")
	private readonly universalNode = this.tree.AddNode("Universal Heroes")

	private strengthSelector?: Menu.ImageSelector
	private agilitySelector?: Menu.ImageSelector
	private intellectSelector?: Menu.ImageSelector
	private universalSelector?: Menu.ImageSelector

	private populated = false
	private hasBannedThisDraft = false
	private lastBanAttemptTime = 0
	private readonly sleeper = new TickSleeper()

	private debugLines: string[] = []
	private debugLastBanResult = ""

	constructor() {
		EventsSDK.on("UnitAbilityDataUpdated", this.populateAndRefresh.bind(this))
		EventsSDK.on("ServerInfo", this.populateAndRefresh.bind(this))
		EventsSDK.on("GameStateChanged", this.onGameStateChanged.bind(this))
		EventsSDK.on("PostDataUpdate", this.onPostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
		EventsSDK.on("Draw", this.onDraw.bind(this))

		this.enabled.OnValue(() => {
			this.syncNativeBans()
		})

		this.populateAndRefresh()
	}

	private onDraw(): void {
		if (!this.debugToggle.value || this.debugLines.length === 0) {
			return
		}
		const padX = 8
		const padY = 6

		let maxW = 0
		const totalLines = this.debugLines.length + (this.debugLastBanResult ? 1 : 0)
		const allText = [...this.debugLines]
		if (this.debugLastBanResult) {
			allText.push(this.debugLastBanResult)
		}

		for (const line of allText) {
			const sz = RendererSDK.GetTextSize(line, RendererSDK.DefaultFontName, RendererSDK.DefaultTextSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const textH = RendererSDK.DefaultTextSize
		const x = 50,
			y = 280
		const rectW = maxW + padX * 2
		const rectH = totalLines * textH + padY * 2

		RendererSDK.FilledRect(new Vector2(x - padX, y - padY), new Vector2(rectW, rectH), new Color(0, 0, 0, 220))
		RendererSDK.OutlinedRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			1.5,
			new Color(255, 60, 60, 200)
		)

		let ly = y
		for (const line of this.debugLines) {
			RendererSDK.Text(line, new Vector2(x, ly), Color.White)
			ly += textH
		}
		if (this.debugLastBanResult) {
			RendererSDK.Text(this.debugLastBanResult, new Vector2(x, ly), new Color(255, 220, 0, 255))
		}
	}

	private isSelectionState(state?: DOTAGameState): boolean {
		if (state === undefined) {
			return false
		}
		return (
			state === DOTAGameState.DOTA_GAMERULES_STATE_HERO_SELECTION ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_PLAYER_DRAFT ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_STRATEGY_TIME
		)
	}

	private isBanPhaseActive(): boolean {
		const gameRules = GameRules
		if (!gameRules) {
			return false
		}

		// 1. Direct Turbo rules check
		if (TurboHeroPickRules && TurboHeroPickRules.IsValid) {
			return TurboHeroPickRules.Phase === DOTACustomHeroPickRulesPhase.Ban
		}

		// 2. Built-in wrapper check
		if (gameRules.IsBanPhase) {
			return true
		}

		// 3. Fallback check for Turbo / All Draft selection start
		const state = gameRules.GameState
		if (state === DOTAGameState.DOTA_GAMERULES_STATE_HERO_SELECTION) {
			if (gameRules.GameMode === DOTAGameMode.DOTA_GAMEMODE_TURBO) {
				return TurboHeroPickRules?.Phase !== DOTACustomHeroPickRulesPhase.Pick
			}
			return gameRules.AllDraftPhase === 0
		}

		return false
	}

	private onGameStateChanged(state: DOTAGameState): void {
		if (this.isSelectionState(state)) {
			this.hasBannedThisDraft = false
			this.syncNativeBans()
			this.executeDraftBans()
		}
	}

	private onPostDataUpdate(delta: number): void {
		if (delta === 0) {
			return
		}

		const state = GameRules?.GameState
		if (this.isSelectionState(state)) {
			this.updateDebugInfo()

			if (this.enabled.value && this.isBanPhaseActive() && !this.sleeper.Sleeping) {
				this.executeDraftBans()
			}
		}
	}

	private onGameEnded(): void {
		this.hasBannedThisDraft = false
		this.lastBanAttemptTime = 0
		this.sleeper.Sleep(0)
	}

	private getSelectedHeroIds(): number[] {
		const bannedHeroIds: number[] = []

		const addFromSelector = (selector?: Menu.ImageSelector) => {
			if (!selector) {
				return
			}
			for (const heroName of selector.values) {
				if (selector.IsEnabled(heroName)) {
					const id = UnitData.GetHeroID(heroName)
					if (id > 0 && !bannedHeroIds.includes(id)) {
						bannedHeroIds.push(id)
					}
				}
			}
		}

		addFromSelector(this.strengthSelector)
		addFromSelector(this.agilitySelector)
		addFromSelector(this.intellectSelector)
		addFromSelector(this.universalSelector)

		return bannedHeroIds
	}

	/**
	 * Synchronizes the target ban list with the native C++ engine core.
	 * This must be called anytime options change, BEFORE draft starts.
	 */
	private syncNativeBans(): void {
		if (!this.enabled.value) {
			ToggleBanHeroes(false)
			this.debugLastBanResult = "NATIVE: Disabled (Cleared)"
			return
		}

		const heroIds = this.getSelectedHeroIds()
		if (heroIds.length > 0) {
			ToggleBanHeroes(heroIds)
			this.debugLastBanResult = `NATIVE SYNC: [${heroIds.join(", ")}] (${heroIds.length} heroes)`
		} else {
			ToggleBanHeroes(false)
			this.debugLastBanResult = "NATIVE: No heroes selected"
		}
	}

	/**
	 * Active in-draft execution for Turbo, Captains Mode, and Custom Games.
	 */
	private executeDraftBans(): void {
		if (!this.enabled.value) {
			return
		}

		const heroIds = this.getSelectedHeroIds()
		if (heroIds.length === 0) {
			return
		}

		const gameRules = GameRules
		const alreadyBanned = gameRules?.BannedHeroesIDs ?? []
		const availableIds = heroIds.filter(id => !alreadyBanned.includes(id))

		if (availableIds.length === 0) {
			return
		}

		const now = Date.now()
		if (this.hasBannedThisDraft && now - this.lastBanAttemptTime < 2000) {
			return
		}

		// Re-enforce native core hook
		ToggleBanHeroes(availableIds)

		const strategy = this.banStrategy.SelectedID
		let targetIds: number[] = []

		if (strategy === 0) {
			// Ban First Available
			targetIds = [availableIds[0]]
		} else if (strategy === 1) {
			// Ban All Selected
			targetIds = availableIds
		} else if (strategy === 2) {
			// Random From Selected
			const randomIndex = Math.floor(Math.random() * availableIds.length)
			targetIds = [availableIds[randomIndex]]
		}

		// Send direct console ban commands
		for (const id of targetIds) {
			const heroName = UnitData.GetHeroNameByID(id)
			if (heroName) {
				GameState.ExecuteCommand(`dota_hero_ban ${heroName}`)
			}
			GameState.ExecuteCommand(`dota_hero_ban ${id}`)
		}

		this.hasBannedThisDraft = true
		this.lastBanAttemptTime = now
		this.debugLastBanResult = `EXEC BAN: [${targetIds.join(", ")}] via Command & Native`
		this.sleeper.Sleep(1000)
	}

	private updateDebugInfo(): void {
		const gameRules = GameRules
		const gameState = gameRules?.GameState
		const gameMode = gameRules?.GameMode
		const isBan = this.isBanPhaseActive()

		this.debugLines = [
			`[AutoBan] Enabled=${this.enabled.value} | Strategy=${this.banStrategy.SelectedID}`,
			`  GameState=${gameState} (2=HERO_SEL)`,
			`  GameMode=${gameMode} (23=TURBO, 15=CUSTOM)`,
			`  IsBanPhaseActive=${isBan}`,
			`  TurboPhase=${TurboHeroPickRules?.Phase}`,
			`  BannedInGame=[${gameRules?.BannedHeroesIDs?.join(", ") ?? ""}]`
		]
	}

	private populateAndRefresh(): void {
		if (this.populated) {
			this.syncNativeBans()
			return
		}

		if (UnitData.globalStorage.size === 0) {
			return
		}

		const strengthHeroes: string[] = []
		const agilityHeroes: string[] = []
		const intellectHeroes: string[] = []
		const universalHeroes: string[] = []

		for (const [name, data] of UnitData.globalStorage) {
			if (!name.startsWith("npc_dota_hero_") || data.HeroID <= 0 || !data.HeroEnabled) {
				continue
			}

			switch (data.AttributePrimary) {
				case Attributes.DOTA_ATTRIBUTE_STRENGTH:
					strengthHeroes.push(name)
					break
				case Attributes.DOTA_ATTRIBUTE_AGILITY:
					agilityHeroes.push(name)
					break
				case Attributes.DOTA_ATTRIBUTE_INTELLECT:
					intellectHeroes.push(name)
					break
				case Attributes.DOTA_ATTRIBUTE_ALL:
					universalHeroes.push(name)
					break
			}
		}

		const sortAlphabetically = (a: string, b: string) => a.localeCompare(b)
		strengthHeroes.sort(sortAlphabetically)
		agilityHeroes.sort(sortAlphabetically)
		intellectHeroes.sort(sortAlphabetically)
		universalHeroes.sort(sortAlphabetically)

		if (strengthHeroes.length > 0) {
			this.strengthSelector = this.strengthNode.AddImageSelector("Strength Heroes", strengthHeroes)
			this.strengthSelector.OnValue(() => this.syncNativeBans())
		}
		if (agilityHeroes.length > 0) {
			this.agilitySelector = this.agilityNode.AddImageSelector("Agility Heroes", agilityHeroes)
			this.agilitySelector.OnValue(() => this.syncNativeBans())
		}
		if (intellectHeroes.length > 0) {
			this.intellectSelector = this.intellectNode.AddImageSelector("Intelligence Heroes", intellectHeroes)
			this.intellectSelector.OnValue(() => this.syncNativeBans())
		}
		if (universalHeroes.length > 0) {
			this.universalSelector = this.universalNode.AddImageSelector("Universal Heroes", universalHeroes)
			this.universalSelector.OnValue(() => this.syncNativeBans())
		}

		this.populated = true
		this.syncNativeBans()
	}
})()

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
		"Debug Overlay",
		true,
		"Display drafting & ban state on screen during hero selection",
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
	private banAttemptCount = 0
	private lastBanAttemptTime = 0
	private readonly sleeper = new TickSleeper()

	private debugLines: string[] = []
	private debugStatus = ""

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
		if (!this.debugToggle.value) {
			return
		}
		const state = GameRules?.GameState
		if (!this.isSelectionState(state)) {
			return
		}

		const padX = 10
		const padY = 8
		const textH = RendererSDK.DefaultTextSize
		const x = 50,
			y = 200

		const allText = [...this.debugLines]
		if (this.debugStatus) {
			allText.push(`  Status: ${this.debugStatus}`)
		}

		let maxW = 0
		for (const line of allText) {
			const sz = RendererSDK.GetTextSize(line, RendererSDK.DefaultFontName, RendererSDK.DefaultTextSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const rectW = Math.max(maxW + padX * 2, 280)
		const rectH = allText.length * textH + padY * 2

		RendererSDK.FilledRect(new Vector2(x - padX, y - padY), new Vector2(rectW, rectH), new Color(0, 0, 0, 220))
		RendererSDK.OutlinedRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			1.5,
			new Color(255, 60, 60, 220)
		)

		let ly = y
		for (let i = 0; i < allText.length; i++) {
			const line = allText[i]
			const color = i === 0 ? Color.Yellow : i === allText.length - 1 ? Color.Green : Color.White
			RendererSDK.Text(line, new Vector2(x, ly), color)
			ly += textH
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
			state === DOTAGameState.DOTA_GAMERULES_STATE_STRATEGY_TIME ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD
		)
	}

	private isBanPhaseActive(): boolean {
		const gameRules = GameRules
		if (!gameRules) {
			return false
		}

		const state = gameRules.GameState
		if (
			state !== DOTAGameState.DOTA_GAMERULES_STATE_HERO_SELECTION &&
			state !== DOTAGameState.DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP &&
			state !== DOTAGameState.DOTA_GAMERULES_STATE_PLAYER_DRAFT
		) {
			return false
		}

		// 1. Direct Turbo rules entity check
		if (TurboHeroPickRules && TurboHeroPickRules.IsValid) {
			return TurboHeroPickRules.Phase === DOTACustomHeroPickRulesPhase.Ban
		}

		// 2. Built-in wrapper check
		if (gameRules.IsBanPhase) {
			return true
		}

		// 3. Fallback for Turbo mode
		if (gameRules.GameMode === DOTAGameMode.DOTA_GAMEMODE_TURBO) {
			return TurboHeroPickRules?.Phase !== DOTACustomHeroPickRulesPhase.Pick
		}

		// 4. All Draft fallback
		if (
			gameRules.GameMode === DOTAGameMode.DOTA_GAMEMODE_ALL_DRAFT ||
			gameRules.GameMode === DOTAGameMode.DOTA_GAMEMODE_AP
		) {
			return gameRules.AllDraftPhase === 0
		}

		return true
	}

	private onGameStateChanged(state: DOTAGameState): void {
		if (this.isSelectionState(state)) {
			this.banAttemptCount = 0
			this.lastBanAttemptTime = 0
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
			this.syncNativeBans()
			this.updateDebugInfo()

			if (this.enabled.value && this.isBanPhaseActive() && !this.sleeper.Sleeping) {
				this.executeDraftBans()
			}
		}
	}

	private onGameEnded(): void {
		this.banAttemptCount = 0
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

	private syncNativeBans(): void {
		if (!this.enabled.value) {
			ToggleBanHeroes(false)
			return
		}

		const heroIds = this.getSelectedHeroIds()
		if (heroIds.length > 0) {
			ToggleBanHeroes(heroIds)
		} else {
			ToggleBanHeroes(false)
		}
	}

	/**
	 * Multi-vector in-draft execution for Turbo Mode and Custom Games.
	 */
	private executeDraftBans(): void {
		if (!this.enabled.value) {
			return
		}

		const heroIds = this.getSelectedHeroIds()
		if (heroIds.length === 0) {
			this.debugStatus = "No heroes selected in menu"
			return
		}

		const gameRules = GameRules
		const alreadyBanned = gameRules?.BannedHeroesIDs ?? []
		const availableIds = heroIds.filter(id => !alreadyBanned.includes(id))

		if (availableIds.length === 0) {
			this.debugStatus = `Target heroes already banned: [${heroIds.join(", ")}]`
			return
		}

		const now = Date.now()
		if (now - this.lastBanAttemptTime < 300) {
			return
		}

		// Vector 1: Re-assert native core hook
		ToggleBanHeroes(availableIds)

		const strategy = this.banStrategy.SelectedID
		let targetIds: number[] = []

		if (strategy === 0) {
			targetIds = [availableIds[0]]
		} else if (strategy === 1) {
			targetIds = availableIds
		} else if (strategy === 2) {
			const randomIndex = Math.floor(Math.random() * availableIds.length)
			targetIds = [availableIds[randomIndex]]
		}

		// Find Panorama Root Panel
		let rootPanel: any
		try {
			if (typeof Panorama !== "undefined" && Panorama) {
				rootPanel = Panorama.FindRootPanel("DotaDashboard") ?? Panorama.FindRootPanel("DotaHud")
			}
		} catch {
			// ignore
		}

		for (const id of targetIds) {
			const heroName = UnitData.GetHeroNameByID(id)

			// Vector 2: Panorama ExecuteScript (Runs directly inside Dota 2 UI thread)
			try {
				if (typeof Panorama !== "undefined" && Panorama && rootPanel) {
					Panorama.ExecuteScript(
						rootPanel,
						`try {
							$.DispatchEvent('DOTACustomHeroPickRulesHeroBanned', ${id});
							$.DispatchEvent('DOTAHeroSelected', ${id}, true);
							$.DispatchEvent('DOTAPickHero', ${id}, true);
							$.DispatchEvent('DOTABanHero', ${id});
							$.DispatchEvent('DOTAHeroSelectionBanHero', ${id});
							$.DispatchEvent('DOTASuggestHero', ${id}, true);
							if (typeof GameEvents !== 'undefined' && GameEvents) {
								GameEvents.SendCustomGameEventToServer('dota_hero_ban', { hero_id: ${id} });
								GameEvents.SendCustomGameEventToServer('custom_hero_pick_rules_hero_banned', { hero_id: ${id} });
								GameEvents.SendCustomGameEventToServer('turbo_hero_banned', { hero_id: ${id} });
							}
						} catch(e) {}`
					)
				}
			} catch {
				// ignore
			}

			// Vector 3: Panorama.DispatchEventAsync with exact JS invocation syntax
			try {
				if (typeof Panorama !== "undefined" && Panorama) {
					Panorama.DispatchEventAsync(`DOTACustomHeroPickRulesHeroBanned(${id})`, rootPanel, 0)
					Panorama.DispatchEventAsync(`DOTAHeroSelected(${id}, true)`, rootPanel, 0)
					Panorama.DispatchEventAsync(`DOTABanHero(${id})`, rootPanel, 0)
					Panorama.DispatchEventAsync(`DOTAPickHero(${id}, true)`, rootPanel, 0)
					Panorama.DispatchEventAsync(`DOTASuggestHero(${id}, true)`, rootPanel, 0)
				}
			} catch {
				// ignore
			}

			// Vector 4: CustomGameEvents server fire
			try {
				if (typeof CustomGameEvents !== "undefined" && CustomGameEvents) {
					const eventMap = new Map<string, any>()
					eventMap.set("hero_id", id)
					eventMap.set("hero_name", heroName)
					CustomGameEvents.FireEventToServer("dota_hero_ban", eventMap)

					const banEvent = new Map<string, any>()
					banEvent.set("hero_id", id)
					CustomGameEvents.FireEventToServer("custom_hero_pick_rules_hero_banned", banEvent)
					CustomGameEvents.FireEventToServer("turbo_hero_banned", banEvent)
				}
			} catch {
				// ignore
			}

			// Vector 5: Console Command triggers
			if (heroName) {
				GameState.ExecuteCommand(`dota_select_hero ${heroName}`)
			}
		}

		this.banAttemptCount++
		this.lastBanAttemptTime = now
		this.debugStatus = `Banning [${targetIds
			.map(id => UnitData.GetHeroNameByID(id).replace("npc_dota_hero_", "") || id)
			.join(", ")}] (Attempt #${this.banAttemptCount})`
		this.sleeper.Sleep(350)
	}

	private updateDebugInfo(): void {
		const gameRules = GameRules
		const gameState = gameRules?.GameState
		const gameMode = gameRules?.GameMode
		const isBan = this.isBanPhaseActive()
		const selectedIds = this.getSelectedHeroIds()
		const selectedNames = selectedIds
			.map(id => UnitData.GetHeroNameByID(id).replace("npc_dota_hero_", "") || id)
			.join(", ")

		this.debugLines = [
			`[Auto Ban Turbo/AllDraft] Enabled=${this.enabled.value}`,
			`  Selected (${selectedIds.length}): [${selectedNames || "NONE"}]`,
			`  GameState=${gameState} | Mode=${gameMode} (23=Turbo)`,
			`  IsBanPhase=${isBan} | TurboPhase=${TurboHeroPickRules?.Phase}`,
			`  Server Banned IDs: [${gameRules?.BannedHeroesIDs?.join(", ") ?? ""}]`
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

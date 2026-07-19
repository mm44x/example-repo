import {
	Attributes,
	Color,
	DOTAGameState,
	EventsSDK,
	GameRules,
	Menu,
	RendererSDK,
	UnitData,
	Vector2
} from "github.com/octarine-public/wrapper/index"

new (class AutoBanUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly tree = this.entry.AddNode("Auto Ban Heroes")
	private readonly enabled = this.tree.AddToggle("Enabled", false)
	private readonly debugToggle = this.tree.AddToggle("Debug Draw", false, "", 10)

	private readonly strengthNode = this.tree.AddNode("Strength Heroes")
	private readonly agilityNode = this.tree.AddNode("Agility Heroes")
	private readonly intellectNode = this.tree.AddNode("Intelligence Heroes")
	private readonly universalNode = this.tree.AddNode("Universal Heroes")

	private strengthSelector?: Menu.ImageSelector
	private agilitySelector?: Menu.ImageSelector
	private intellectSelector?: Menu.ImageSelector
	private universalSelector?: Menu.ImageSelector

	private populated = false
	private lastUpdateTime = 0

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
			this.updateBans()
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
		const x = 50, y = 300
		const rectW = maxW + padX * 2
		const rectH = totalLines * textH + padY * 2

		RendererSDK.FilledRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			new Color(0, 0, 0, 255)
		)

		let ly = y
		for (const line of this.debugLines) {
			RendererSDK.Text(line, new Vector2(x, ly), Color.White)
			ly += textH
		}
		if (this.debugLastBanResult) {
			RendererSDK.Text(this.debugLastBanResult, new Vector2(x, ly), Color.Yellow)
		}
	}

	private isSelectionState(state: DOTAGameState): boolean {
		return (
			state === DOTAGameState.DOTA_GAMERULES_STATE_HERO_SELECTION ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_PLAYER_DRAFT ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP ||
			state === DOTAGameState.DOTA_GAMERULES_STATE_STRATEGY_TIME
		)
	}

	private onGameStateChanged(state: DOTAGameState): void {
		if (this.isSelectionState(state)) {
			this.updateBans()
		}
	}

	private onPostDataUpdate(delta: number): void {
		if (delta === 0) {
			return
		}
		const state = GameRules?.GameState
		if (state !== undefined && this.isSelectionState(state)) {
			const now = Date.now()
			if (now - this.lastUpdateTime > 1000) {
				// change from 200ms to 1000ms to avoid log spam
				this.lastUpdateTime = now
				this.updateBans()
			}
		}
	}

	private onGameEnded(): void {
		console.log("[AutoBan] GameEnded")
		this.lastUpdateTime = 0
	}

	private populateAndRefresh(): void {
		if (this.populated) {
			this.updateBans()
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
			this.strengthSelector = this.strengthNode.AddImageSelector("Strength Selectors", strengthHeroes)
			this.strengthSelector.OnValue(() => this.updateBans())
		}
		if (agilityHeroes.length > 0) {
			this.agilitySelector = this.agilityNode.AddImageSelector("Agility Selectors", agilityHeroes)
			this.agilitySelector.OnValue(() => this.updateBans())
		}
		if (intellectHeroes.length > 0) {
			this.intellectSelector = this.intellectNode.AddImageSelector("Intelligence Selectors", intellectHeroes)
			this.intellectSelector.OnValue(() => this.updateBans())
		}
		if (universalHeroes.length > 0) {
			this.universalSelector = this.universalNode.AddImageSelector("Universal Selectors", universalHeroes)
			this.universalSelector.OnValue(() => this.updateBans())
		}

		this.populated = true
		console.log("[AutoBan] Populated selectors")
		this.updateBans()
	}

	private updateBans(): void {
		const gameRules = GameRules
		const gameState = gameRules?.GameState
		const gameMode = gameRules?.GameMode
		const isBanPhase = gameRules?.IsBanPhase

		this.debugLines = [
			`[AutoBan] enabled=${this.enabled.value}`,
			`  gameState=${gameState} (2=HERO_SEL, 9=CUSTOM_SETUP, 12=PLAYER_DRAFT)`,
			`  gameMode=${gameMode} (15=CUSTOM, 23=TURBO)`,
			`  IsBanPhase=${isBanPhase}`,
			`  AllDraftPhase=${gameRules?.AllDraftPhase}`
		]

		if (!this.enabled.value) {
			ToggleBanHeroes(false)
			this.debugLastBanResult = "DISABLED - ToggleBanHeroes(false)"
			return
		}
		if (!(isBanPhase ?? false)) {
			this.debugLastBanResult = "SKIP - not ban phase"
			return
		}

		const bannedHeroIds: number[] = []

		const addSelectedHeroIds = (selector?: Menu.ImageSelector) => {
			if (!selector) {
				return
			}
			for (const heroName of selector.values) {
				if (selector.IsEnabled(heroName)) {
					const id = UnitData.GetHeroID(heroName)
					if (id > 0) {
						bannedHeroIds.push(id)
					}
				}
			}
		}

		addSelectedHeroIds(this.strengthSelector)
		addSelectedHeroIds(this.agilitySelector)
		addSelectedHeroIds(this.intellectSelector)
		addSelectedHeroIds(this.universalSelector)

		if (bannedHeroIds.length > 0) {
			ToggleBanHeroes(bannedHeroIds)
			this.debugLastBanResult = `BANNED: [${bannedHeroIds.join(", ")}]`
		} else {
			ToggleBanHeroes(false)
			this.debugLastBanResult = "NO SELECTION - ToggleBanHeroes(false)"
		}
	}
})()

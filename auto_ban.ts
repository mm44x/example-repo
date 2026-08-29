import {
	Attributes,
	Color,
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
	private readonly enabled = this.tree.AddToggle("Enabled", true, "Master ON/OFF toggle for Auto Ban")
	private readonly debugToggle = this.tree.AddToggle(
		"Debug Overlay",
		true,
		"Display drafting state and selected bans on screen",
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

	constructor() {
		EventsSDK.on("UnitAbilityDataUpdated", this.populateAndRefresh.bind(this))
		EventsSDK.on("ServerInfo", this.populateAndRefresh.bind(this))
		EventsSDK.on("GameStateChanged", this.syncNativeBans.bind(this))
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
		const gameRules = GameRules
		if (!gameRules) {
			return
		}
		const state = gameRules.GameState
		if (state === undefined || state > 4) {
			return
		}

		const padX = 12
		const padY = 10
		const lineSpacing = 4
		const fontSize = RendererSDK.DefaultTextSize
		const textH = fontSize + lineSpacing
		const x = 50
		const y = 200

		const selectedIds = this.getSelectedHeroIds()
		const selectedNames = selectedIds
			.map(id => UnitData.GetHeroNameByID(id).replace("npc_dota_hero_", "") || id)
			.join(", ")

		const bannedInGame = (gameRules.BannedHeroesIDs ?? [])
			.map(id => UnitData.GetHeroNameByID(id).replace("npc_dota_hero_", "") || id)
			.join(", ")

		const lines = [
			`[Auto Ban] Enabled=${this.enabled.value}`,
			`  Selected (${selectedIds.length}): [${selectedNames || "NONE"}]`,
			`  Game State: ${state} | Mode: ${gameRules.GameMode}`,
			`  Server Banned: [${bannedInGame || "None"}]`
		]

		let maxW = 0
		for (const line of lines) {
			const sz = RendererSDK.GetTextSize(line, RendererSDK.DefaultFontName, fontSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const rectW = maxW + padX * 2
		const rectH = lines.length * textH + padY * 2

		RendererSDK.FilledRect(new Vector2(x - padX, y - padY), new Vector2(rectW, rectH), new Color(15, 18, 24, 255))
		RendererSDK.OutlinedRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			1.5,
			new Color(255, 60, 60, 255)
		)

		let ly = y
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const color = i === 0 ? Color.Yellow : Color.White
			RendererSDK.Text(line, new Vector2(x, ly), color)
			ly += textH
		}
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

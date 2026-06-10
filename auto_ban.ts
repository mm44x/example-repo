import {
	Attributes,
	DOTAGameState,
	EventsSDK,
	GameRules,
	Menu,
	UnitData
} from "github.com/octarine-public/wrapper/index"

new (class AutoBanUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly tree = this.entry.AddNode("Auto Ban Heroes", "menu/icons/juggernaut.svg")
	private readonly enabled = this.tree.AddToggle("Enabled", false)

	private readonly strengthNode = this.tree.AddNode("Strength Heroes")
	private readonly agilityNode = this.tree.AddNode("Agility Heroes")
	private readonly intellectNode = this.tree.AddNode("Intelligence Heroes")
	private readonly universalNode = this.tree.AddNode("Universal Heroes")

	private strengthSelector?: Menu.ImageSelector
	private agilitySelector?: Menu.ImageSelector
	private intellectSelector?: Menu.ImageSelector
	private universalSelector?: Menu.ImageSelector

	private populated = false
	private lastBanPhaseState = false

	constructor() {
		EventsSDK.on("UnitAbilityDataUpdated", this.populateAndRefresh.bind(this))
		EventsSDK.on("ServerInfo", this.populateAndRefresh.bind(this))
		EventsSDK.on("GameStateChanged", this.onGameStateChanged.bind(this))
		EventsSDK.on("PostDataUpdate", this.onPostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))

		this.enabled.OnValue(() => {
			this.updateBans()
		})

		this.populateAndRefresh()
	}

	private onGameStateChanged(state: DOTAGameState): void {
		if (state === DOTAGameState.DOTA_GAMERULES_STATE_HERO_SELECTION) {
			this.updateBans()
		}
	}

	private onPostDataUpdate(delta: number): void {
		if (delta === 0) {
			return
		}
		const isBanPhase = GameRules?.IsBanPhase ?? false
		if (isBanPhase !== this.lastBanPhaseState) {
			this.lastBanPhaseState = isBanPhase
			if (isBanPhase) {
				this.updateBans()
			}
		}
	}

	private onGameEnded(): void {
		this.lastBanPhaseState = false
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
		this.updateBans()
	}

	private updateBans(): void {
		if (!this.enabled.value) {
			ToggleBanHeroes(false)
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
		} else {
			ToggleBanHeroes(false)
		}
	}
})()

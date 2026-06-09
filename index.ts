import "./auto_ban"
import "./rubick_combo"
import "./last_hit"

import {
	Ability,
	Attributes,
	Color,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	Fountain,
	GameState,
	Hero,
	Item,
	item_power_treads,
	LocalPlayer,
	Menu,
	PowerTreadsAttribute,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

interface ScheduledSwitch {
	time: number
	attribute: PowerTreadsAttribute
}

interface SpellConfig {
	name: string
	label: string
	piercesBkb: boolean
	castType: "target" | "position" | "no_target"
}

const SUPPORTED_SPELLS: SpellConfig[] = [
	{ name: "lion_voodoo", label: "Lion Hex", piercesBkb: false, castType: "target" },
	{ name: "lion_impale", label: "Lion Earth Spike", piercesBkb: false, castType: "position" },
	{ name: "shadow_shaman_voodoo", label: "Shaman Hex", piercesBkb: false, castType: "target" },
	{ name: "shadow_shaman_shackles", label: "Shackles", piercesBkb: false, castType: "target" },
	{ name: "rubick_telekinesis", label: "Telekinesis", piercesBkb: false, castType: "target" },
	{ name: "dragon_knight_dragon_tail", label: "Dragon Tail", piercesBkb: false, castType: "target" },
	{ name: "crystal_maiden_frostbite", label: "Frostbite", piercesBkb: false, castType: "target" },
	{
		name: "obsidian_destroyer_astral_imprisonment",
		label: "Astral Imprisonment",
		piercesBkb: false,
		castType: "target"
	},
	{ name: "shadow_demon_disruption", label: "Disruption", piercesBkb: false, castType: "target" },
	{ name: "bane_nightmare", label: "Nightmare", piercesBkb: false, castType: "target" },
	{ name: "bane_fiends_grip", label: "Fiend's Grip", piercesBkb: true, castType: "target" },
	{ name: "beastmaster_primal_roar", label: "Primal Roar", piercesBkb: true, castType: "target" },
	{ name: "doom_bringer_doom", label: "Doom", piercesBkb: true, castType: "target" },
	{ name: "legion_commander_duel", label: "Duel", piercesBkb: true, castType: "target" },
	{ name: "necrolyte_reapers_scythe", label: "Reaper's Scythe", piercesBkb: true, castType: "target" }
]

new (class AutoBootsUtility {
	private readonly entry = Menu.AddEntry("Utility")

	// Auto Boots Nodes
	private readonly bootsTree = this.entry.AddNode("Auto Boots")
	private readonly phaseEnabled = this.bootsTree.AddToggle("Auto Phase Boots", true)
	private readonly phaseSleeper = new TickSleeper()

	private readonly treadsEnabled = this.bootsTree.AddToggle("Auto Power Treads", true)
	private switchQueue: ScheduledSwitch[] = []

	// Anti Initiation Nodes
	private readonly antiInitiationNode = this.entry.AddNode("Anti Initiation")
	private readonly antiInitEnabled = this.antiInitiationNode.AddToggle("Enabled", true)
	private readonly antiInitRange = this.antiInitiationNode.AddSlider("Trigger Range", 450, 200, 800)
	private readonly antiInitSuddenOnly = this.antiInitiationNode.AddToggle("Only on Sudden Arrival", true)
	private readonly antiInitDebug = this.antiInitiationNode.AddToggle("Draw Debug Overlay", true)

	// Items Node
	private readonly itemsNode = this.antiInitiationNode.AddNode("Items Selection")

	private readonly useHex = this.itemsNode.AddToggle("Scythe of Vyse (Hex)", true)
	private readonly hexPriority = this.itemsNode.AddSlider("Hex Priority", 1, 1, 10)

	private readonly useEul = this.itemsNode.AddToggle("Eul's / Wind Waker", true)
	private readonly eulPriority = this.itemsNode.AddSlider("Eul Priority", 2, 1, 10)

	private readonly useAbyssal = this.itemsNode.AddToggle("Abyssal Blade", true)
	private readonly abyssalPriority = this.itemsNode.AddSlider("Abyssal Priority", 3, 1, 10)

	private readonly useBlink = this.itemsNode.AddToggle("Blink Dagger (Escape)", true)
	private readonly blinkPriority = this.itemsNode.AddSlider("Blink Priority", 4, 1, 10)

	private readonly useManta = this.itemsNode.AddToggle("Manta Style", true)
	private readonly mantaPriority = this.itemsNode.AddSlider("Manta Priority", 5, 1, 10)

	private readonly useOrchid = this.itemsNode.AddToggle("Orchid / Bloodthorn", true)
	private readonly orchidPriority = this.itemsNode.AddSlider("Orchid Priority", 6, 1, 10)

	private readonly useGlimmer = this.itemsNode.AddToggle("Glimmer Cape", true)
	private readonly glimmerPriority = this.itemsNode.AddSlider("Glimmer Priority", 7, 1, 10)

	private readonly usePike = this.itemsNode.AddToggle("Hurricane Pike", true)
	private readonly pikePriority = this.itemsNode.AddSlider("Pike Priority", 8, 1, 10)

	private readonly useInvis = this.itemsNode.AddToggle("Shadow Blade / Silver Edge", true)
	private readonly invisPriority = this.itemsNode.AddSlider("Invis Priority", 9, 1, 10)

	private readonly useHalberd = this.itemsNode.AddToggle("Heaven's Halberd", true)
	private readonly halberdPriority = this.itemsNode.AddSlider("Halberd Priority", 10, 1, 10)

	private readonly useAtos = this.itemsNode.AddToggle("Atos / Gleipnir", true)
	private readonly atosPriority = this.itemsNode.AddSlider("Atos Priority", 10, 1, 10)

	// Spells Node & Map creation
	private readonly spellsNode = this.antiInitiationNode.AddNode("Spells Selection")
	private readonly spellSettings = SUPPORTED_SPELLS.map(spell => {
		return {
			name: spell.name,
			toggle: this.spellsNode.AddToggle(spell.label, true),
			priority: this.spellsNode.AddSlider(spell.label + " Priority", 1, 1, 10),
			config: spell
		}
	})

	// Tracking states
	private readonly lastEnemyPositions = new Map<number, Vector3>()
	private readonly enemyVisibility = new Map<number, boolean>()
	private readonly antiInitSleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("PrepareUnitOrders", this.PrepareUnitOrders.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
	}

	private get hasLocalHero() {
		return LocalPlayer?.Hero !== undefined
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (hero === undefined || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Process Power Treads scheduled switchbacks
		if (this.treadsEnabled.value && this.switchQueue.length > 0) {
			const now = GameState.RawGameTime
			const powerTreads = hero.Items.find(item => item.Name === "item_power_treads") as
				| item_power_treads
				| undefined
			if (powerTreads && powerTreads.IsValid) {
				while (this.switchQueue.length > 0 && this.switchQueue[0].time <= now) {
					const task = this.switchQueue.shift()
					if (task) {
						powerTreads.SwitchAttribute(task.attribute, false)
					}
				}
			} else {
				this.switchQueue = []
			}
		}

		// Auto Phase Boots logic
		if (this.phaseEnabled.value && !this.phaseSleeper.Sleeping) {
			// Do not cast if channeling (e.g. TP Scroll or channeling spells)
			if (hero.IsChanneling) {
				return
			}

			// Do not cast when invisible to avoid breaking invisibility
			if (hero.IsInvisible) {
				return
			}

			// Do not cast if already has Phase Boots active buff
			if (hero.Buffs.some(buff => buff.Name === "modifier_item_phase_boots_active")) {
				return
			}

			// Only cast when moving
			if (!hero.IsMoving) {
				return
			}

			const phaseBoots = hero.Items.find(item => item.Name === "item_phase_boots")
			if (phaseBoots) {
				const ready =
					phaseBoots.CanBeUsable &&
					!hero.IsMuted &&
					hero.Mana >= phaseBoots.ManaCost &&
					phaseBoots.Cooldown <= 0.1
				if (ready) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: phaseBoots.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					const delay = GameState.InputLag * 1000 + Math.randomRange(50, 150)
					this.phaseSleeper.Sleep(delay)
				}
			}
		}

		// Anti-Initiation state tracking and casting
		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		for (const heroEntity of allHeroes) {
			if (heroEntity && heroEntity.IsValid && heroEntity.IsEnemy(hero) && !heroEntity.IsIllusion) {
				if (heroEntity.IsVisible && heroEntity.IsAlive) {
					if (
						this.antiInitEnabled.value &&
						!this.antiInitSleeper.Sleeping &&
						!hero.IsChanneling &&
						!hero.IsInvisible
					) {
						this.checkAndCastAntiInitiation(hero, heroEntity)
					}
					this.lastEnemyPositions.set(heroEntity.Index, heroEntity.Position.Clone())
					this.enemyVisibility.set(heroEntity.Index, true)
				} else {
					this.enemyVisibility.set(heroEntity.Index, false)
				}
			}
		}
	}

	private getItemConfigs(hero: Hero, enemy: Hero, isTargetImmune: boolean) {
		return [
			{
				toggle: this.useHex,
				priority: this.hexPriority,
				names: ["item_sheepstick"],
				piercesBkb: false,
				isSelfCast: false,
				cast: (item: Item) => {
					if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: enemy.Index,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			},
			{
				toggle: this.useEul,
				priority: this.eulPriority,
				names: ["item_cyclone", "item_wind_waker"],
				piercesBkb: true, // We self-cast Eul's if they are BKB immune
				isSelfCast: false,
				cast: (item: Item) => {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: isTargetImmune ? hero.Index : enemy ? enemy.Index : hero.Index,
						ability: item.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
			},
			{
				toggle: this.useAbyssal,
				priority: this.abyssalPriority,
				names: ["item_abyssal_blade"],
				piercesBkb: true,
				isSelfCast: false,
				cast: (item: Item) => {
					if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: enemy.Index,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			},
			{
				toggle: this.useBlink,
				priority: this.blinkPriority,
				names: ["item_blink", "item_overwhelming_blink", "item_swift_blink", "item_arcane_blink"],
				piercesBkb: true,
				isSelfCast: true,
				cast: (item: Item) => {
					const friendlyFountain = EntityManager.GetEntitiesByClass(Fountain).find(
						f => f && f.IsValid && !f.IsEnemy(hero)
					)
					const fountainPos = friendlyFountain
						? friendlyFountain.Position.Clone()
						: hero.Team === 2
						? new Vector3(-7400, -7300, 512)
						: new Vector3(7400, 7300, 512)
					const dir = fountainPos.Subtract(hero.Position).Normalize()
					const targetPos = hero.Position.Add(dir.MultiplyScalar(1200))
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: targetPos,
						ability: item.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
			},
			{
				toggle: this.useManta,
				priority: this.mantaPriority,
				names: ["item_manta"],
				piercesBkb: true,
				isSelfCast: true,
				cast: (item: Item) => {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: item.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
			},
			{
				toggle: this.useOrchid,
				priority: this.orchidPriority,
				names: ["item_orchid", "item_bloodthorn"],
				piercesBkb: false,
				isSelfCast: false,
				cast: (item: Item) => {
					if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: enemy.Index,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			},
			{
				toggle: this.useGlimmer,
				priority: this.glimmerPriority,
				names: ["item_glimmer_cape"],
				piercesBkb: true,
				isSelfCast: true,
				cast: (item: Item) => {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: hero.Index,
						ability: item.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
			},
			{
				toggle: this.usePike,
				priority: this.pikePriority,
				names: ["item_hurricane_pike"],
				piercesBkb: false,
				isSelfCast: false,
				cast: (item: Item) => {
					if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: enemy.Index,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			},
			{
				toggle: this.useInvis,
				priority: this.invisPriority,
				names: ["item_invis_sword", "item_silver_edge"],
				piercesBkb: true,
				isSelfCast: true,
				cast: (item: Item) => {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: item.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
			},
			{
				toggle: this.useHalberd,
				priority: this.halberdPriority,
				names: ["item_heavens_halberd"],
				piercesBkb: false,
				isSelfCast: false,
				cast: (item: Item) => {
					if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: enemy.Index,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			},
			{
				toggle: this.useAtos,
				priority: this.atosPriority,
				names: ["item_rod_of_atos", "item_gungir"],
				piercesBkb: false,
				isSelfCast: false,
				cast: (item: Item) => {
					if (item.Name === "item_rod_of_atos") {
						if (enemy) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: enemy.Index,
								ability: item.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
						}
					} else if (enemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: enemy.Position,
							ability: item.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
				}
			}
		]
	}

	private getCandidates(
		hero: Hero,
		enemy: Hero,
		isTargetImmune: boolean
	): { name: string; priorityValue: number; cast: () => void }[] {
		const itemConfigs = this.getItemConfigs(hero, enemy, isTargetImmune)
		const candidates: { name: string; priorityValue: number; cast: () => void }[] = []

		// 1. Collect Item Candidates (requires hero not to be muted, stunned, or hexed)
		if (!hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			for (const config of itemConfigs) {
				if (!config.toggle.value) {
					continue
				}
				if (isTargetImmune && !config.piercesBkb) {
					continue
				}

				const item = hero.Items.find(i => config.names.includes(i.Name))
				if (item) {
					const itemReady =
						item.CanBeUsable && !hero.IsMuted && hero.Mana >= item.ManaCost && item.Cooldown <= 0.1
					if (itemReady) {
						const isEulSelfCast =
							isTargetImmune && (item.Name === "item_cyclone" || item.Name === "item_wind_waker")
						const isSelfCast = config.isSelfCast || isEulSelfCast
						const castRange = item.CastRange > 0 ? item.CastRange : 600
						const inRange = isSelfCast || hero.Distance2D(enemy) <= castRange
						if (inRange) {
							let displayName = config.toggle.Name
							if (item.Name === "item_cyclone") {
								displayName = "Eul's Scepter"
							} else if (item.Name === "item_wind_waker") {
								displayName = "Wind Waker"
							}
							candidates.push({
								name: displayName,
								cast: () => config.cast(item),
								priorityValue: config.priority.value
							})
						}
					}
				}
			}
		}

		// 2. Collect Spell Candidates (requires hero not to be silenced, stunned, or hexed)
		if (!hero.IsSilenced && !hero.IsStunned && !hero.IsHexed) {
			for (const config of this.spellSettings) {
				if (!config.toggle.value) {
					continue
				}
				if (isTargetImmune && !config.config.piercesBkb) {
					continue
				}

				const spell: Ability | undefined = hero.GetAbilityByName(config.name)
				if (
					spell &&
					spell.IsValid &&
					!spell.IsHidden &&
					spell.Level > 0 &&
					spell.Cooldown <= 0.1 &&
					hero.Mana >= spell.ManaCost
				) {
					const castRange = spell.CastRange > 0 ? spell.CastRange : 600
					const inRange = hero.Distance2D(enemy) <= castRange
					if (inRange) {
						candidates.push({
							name: config.config.label,
							cast: () => {
								if (config.config.castType === "target") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
										issuers: [hero],
										target: enemy.Index,
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
								} else if (config.config.castType === "position") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
										issuers: [hero],
										position: enemy.Position,
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
								} else if (config.config.castType === "no_target") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
										issuers: [hero],
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
								}
							},
							priorityValue: config.priority.value
						})
					}
				}
			}
		}

		// Sort by priority slider value (ascending: 1 first, then 2, etc.)
		candidates.sort((a, b) => a.priorityValue - b.priorityValue)
		return candidates
	}

	private checkAndCastAntiInitiation(hero: Hero, enemy: Hero): void {
		const wasVisible = this.enemyVisibility.get(enemy.Index) ?? false
		const lastPos = this.lastEnemyPositions.get(enemy.Index)
		let triggered = false

		if (wasVisible) {
			// Check if they moved > 300 units in a single frame
			if (lastPos && enemy.Position.Distance(lastPos) > 300) {
				triggered = true
			}
		} else if (enemy.Distance(hero) <= this.antiInitRange.value) {
			// Sudden arrival from fog / invis
			triggered = true
		}

		// If sudden arrival toggle is off, trigger on any target in range
		if (!this.antiInitSuddenOnly.value && enemy.Distance(hero) <= this.antiInitRange.value) {
			triggered = true
		}

		if (!triggered) {
			return
		}

		// Skip if target is already disabled
		if (enemy.IsStunned || enemy.IsHexed || enemy.IsNightmared) {
			return
		}

		const isTargetImmune = enemy.IsMagicImmune || enemy.IsDebuffImmune
		const candidates = this.getCandidates(hero, enemy, isTargetImmune)

		if (candidates.length === 0) {
			return
		}

		// Execute the highest priority candidate
		candidates[0].cast()

		// Sleep anti-initiation to prevent action flooding
		const delay = GameState.InputLag * 1000 + Math.randomRange(50, 150)
		this.antiInitSleeper.Sleep(delay)
	}

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero || !this.antiInitDebug.value) {
			return
		}
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		let y = 180
		RendererSDK.Text("--- Anti Initiation Debug ---", new Vector2(50, y), Color.Yellow)
		y += 20

		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			h => h && h.IsValid && h.IsEnemy(hero) && !h.IsIllusion && h.IsVisible && h.IsAlive
		)

		if (enemies.length === 0) {
			RendererSDK.Text("No visible enemies found", new Vector2(50, y), Color.White)
			y += 20
		} else {
			for (const enemy of enemies) {
				const wasVisible = this.enemyVisibility.get(enemy.Index) ?? false
				const dist = enemy.Distance(hero)
				RendererSDK.Text(
					`Enemy: ${enemy.Name} | Dist: ${dist.toFixed(0)} | wasVisible: ${wasVisible} | range: ${
						this.antiInitRange.value
					}`,
					new Vector2(50, y),
					Color.White
				)
				y += 20
			}
		}

		// Active Candidate Queue (Sorted)
		RendererSDK.Text("Active Candidate Queue (Sorted):", new Vector2(50, y), Color.Aqua)
		y += 20
		const testEnemy = enemies[0]
		if (testEnemy) {
			const isTargetImmune = testEnemy.IsMagicImmune || testEnemy.IsDebuffImmune
			const candidates = this.getCandidates(hero, testEnemy, isTargetImmune)
			if (candidates.length === 0) {
				RendererSDK.Text("  No candidates ready & in range", new Vector2(50, y), Color.LightGray)
				y += 20
			} else {
				for (let i = 0; i < candidates.length; i++) {
					const cand = candidates[i]
					const color = i === 0 ? Color.Yellow : Color.White
					RendererSDK.Text(
						`  ${i + 1}. ${cand.name} (Priority: ${cand.priorityValue})`,
						new Vector2(50, y),
						color
					)
					y += 20
				}
			}
		} else {
			RendererSDK.Text("  (No visible enemies - queue empty)", new Vector2(50, y), Color.LightGray)
			y += 20
		}

		// Spells Checks
		RendererSDK.Text("Spells Detection:", new Vector2(50, y), Color.Green)
		y += 20
		for (const config of this.spellSettings) {
			const spell: Ability | undefined = hero.GetAbilityByName(config.name)
			if (!spell) {
				RendererSDK.Text(`  ${config.config.label}: NOT FOUND`, new Vector2(50, y), Color.Red)
				y += 20
				continue
			}
			const castRange = spell.CastRange > 0 ? spell.CastRange : 600
			const manaEnough = hero.Mana >= spell.ManaCost
			const ready = spell.Level > 0 && spell.Cooldown <= 0.1 && manaEnough
			const info = `Lvl: ${spell.Level} | CD: ${spell.Cooldown.toFixed(1)} | Mana: ${hero.Mana.toFixed(0)}/${
				spell.ManaCost
			} | Range: ${castRange} | Ready: ${ready}`
			const color = ready ? Color.Green : Color.LightGray
			RendererSDK.Text(`  ${config.config.label}: ${info}`, new Vector2(50, y), color)
			y += 20
		}

		// Items Checks
		RendererSDK.Text("Items Detection:", new Vector2(50, y), Color.Green)
		y += 20
		const dummyEnemy = enemies[0] || hero
		const itemConfigs = this.getItemConfigs(hero, dummyEnemy, false)
		for (const config of itemConfigs) {
			const itemsFound = hero.Items.filter(i => config.names.includes(i.Name))
			if (itemsFound.length === 0) {
				continue
			}
			for (const item of itemsFound) {
				const ready = item.CanBeUsable && !hero.IsMuted && hero.Mana >= item.ManaCost && item.Cooldown <= 0.1
				const info = `Ready: ${ready} | CD: ${item.Cooldown.toFixed(1)} | Level: ${item.Level} | Usable: ${
					item.CanBeUsable
				}`
				const color = ready ? Color.Green : Color.LightGray
				RendererSDK.Text(`  ${item.Name}: ${info}`, new Vector2(50, y), color)
				y += 20
			}
		}
	}

	private PrepareUnitOrders(order: ExecuteOrder) {
		if (!this.treadsEnabled.value) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Make sure the order is issued by our local hero (manual or script combo)
		if (!order.Issuers.includes(hero)) {
			return
		}

		const powerTreads = hero.Items.find(item => item.Name === "item_power_treads") as item_power_treads | undefined
		if (!powerTreads || !powerTreads.IsValid) {
			return
		}

		const primaryAttr = this.getHeroPrimaryAttribute(hero)

		// Stop or Hold orders => cancel any pending switch and revert immediately
		if (
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_STOP ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_HOLD_POSITION
		) {
			this.switchQueue = []
			powerTreads.SwitchAttribute(primaryAttr, false)
			return
		}

		// Spell cast orders => switch to INT, schedule switch back
		const isCastOrder =
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET

		if (isCastOrder) {
			const ability = order.Ability_
			if (ability && typeof ability !== "number" && !ability.IsItem && ability.ManaCost > 0) {
				// Switch to INT immediately before the spell starts casting
				powerTreads.SwitchAttribute(PowerTreadsAttribute.INTELLIGENCE, false)

				// Schedule switch back after CastPoint + latency buffer (20ms)
				const readyTime = GameState.RawGameTime + ability.CastPoint + 0.02
				this.switchQueue = [{ time: readyTime, attribute: primaryAttr }]
			}
		}
	}

	private getHeroPrimaryAttribute(hero: Hero): PowerTreadsAttribute {
		const primary = hero.PrimaryAttribute
		switch (primary) {
			case Attributes.DOTA_ATTRIBUTE_STRENGTH:
				return PowerTreadsAttribute.STRENGTH
			case Attributes.DOTA_ATTRIBUTE_AGILITY:
				return PowerTreadsAttribute.AGILITY
			case Attributes.DOTA_ATTRIBUTE_INTELLECT:
				return PowerTreadsAttribute.INTELLIGENCE
			default:
				return PowerTreadsAttribute.STRENGTH
		}
	}

	private GameEnded(): void {
		this.phaseSleeper.ResetTimer()
		this.antiInitSleeper.ResetTimer()
		this.switchQueue = []
		this.lastEnemyPositions.clear()
		this.enemyVisibility.clear()
	}
})()

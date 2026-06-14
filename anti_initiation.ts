import {
	Ability,
	Color,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	Fountain,
	GameState,
	Hero,
	Item,
	LocalPlayer,
	Menu,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

interface SpellConfig {
	name: string
	label: string
	piercesBkb: boolean
	castType: "target" | "position" | "no_target"
	castRange?: number
}

const SUPPORTED_SPELLS: SpellConfig[] = [
	{ name: "lion_voodoo", label: "Lion Hex", piercesBkb: false, castType: "target" },
	{ name: "lion_impale", label: "Lion Earth Spike", piercesBkb: false, castType: "position", castRange: 725 },
	{ name: "nyx_assassin_impale", label: "Impale (Nyx)", piercesBkb: false, castType: "position", castRange: 700 },
	{ name: "tiny_avalanche", label: "Avalanche", piercesBkb: false, castType: "position", castRange: 600 },
	{ name: "jakiro_ice_path", label: "Ice Path", piercesBkb: false, castType: "position", castRange: 1200 },
	{ name: "shadow_shaman_voodoo", label: "Shaman Hex", piercesBkb: false, castType: "target" },
	{ name: "shadow_shaman_shackles", label: "Shackles", piercesBkb: false, castType: "target" },
	{ name: "rubick_telekinesis", label: "Telekinesis", piercesBkb: false, castType: "target" },
	{ name: "dragon_knight_dragon_tail", label: "Dragon Tail", piercesBkb: false, castType: "target" },
	{ name: "vengefulspirit_magic_missile", label: "Magic Missile", piercesBkb: false, castType: "target" },
	{ name: "skeleton_king_hellfire_blast", label: "Wraithfire Blast", piercesBkb: false, castType: "target" },
	{ name: "witch_doctor_paralyzing_cask", label: "Paralyzing Cask", piercesBkb: false, castType: "target" },
	{ name: "ogre_magi_fireblast", label: "Fire Blast", piercesBkb: false, castType: "target" },
	{ name: "luna_lucent_beam", label: "Lucent Beam", piercesBkb: false, castType: "target" },
	{ name: "crystal_maiden_frostbite", label: "Frostbite", piercesBkb: false, castType: "target" },
	{
		name: "obsidian_destroyer_astral_imprisonment",
		label: "Astral Imprisonment",
		piercesBkb: false,
		castType: "target"
	},
	{ name: "shadow_demon_disruption", label: "Disruption", piercesBkb: false, castType: "target" },
	{ name: "bane_nightmare", label: "Nightmare", piercesBkb: false, castType: "target" },
	{ name: "skywrath_mage_ancient_seal", label: "Ancient Seal", piercesBkb: false, castType: "target" },
	{ name: "riki_smoke_screen", label: "Smoke Screen", piercesBkb: false, castType: "position", castRange: 550 },
	{
		name: "sniper_concussive_grenade",
		label: "Concussive Grenade",
		piercesBkb: false,
		castType: "position",
		castRange: 600
	},
	{ name: "drow_ranger_wave_of_silence", label: "Gust", piercesBkb: false, castType: "position", castRange: 900 },
	{ name: "bane_fiends_grip", label: "Fiend's Grip", piercesBkb: true, castType: "target" },
	{ name: "beastmaster_primal_roar", label: "Primal Roar", piercesBkb: true, castType: "target" },
	{ name: "doom_bringer_doom", label: "Doom", piercesBkb: true, castType: "target" },
	{ name: "legion_commander_duel", label: "Duel", piercesBkb: true, castType: "target" },
	{ name: "necrolyte_reapers_scythe", label: "Reaper's Scythe", piercesBkb: true, castType: "target" },
	{ name: "earthshaker_fissure", label: "Fissure", piercesBkb: false, castType: "position", castRange: 1400 },
	{ name: "earthshaker_echo_slam", label: "Echo Slam", piercesBkb: true, castType: "no_target", castRange: 600 }
]

new (class AntiInitiationUtility {
	private readonly entry = Menu.AddEntry("mm44x")

	// Anti Initiation Nodes
	private readonly antiInitiationNode = this.entry.AddNode("Anti Initiation")
	private readonly antiInitEnabled = this.antiInitiationNode.AddToggle("Enabled", true)
	private readonly antiInitRange = this.antiInitiationNode.AddSlider("Trigger Range", 450, 200, 800)
	private readonly antiInitSuddenOnly = this.antiInitiationNode.AddToggle("Only on Sudden Arrival", true)
	private readonly antiInitDebug = this.antiInitiationNode.AddToggle("Draw Debug Overlay", true)
	private readonly priorityType = this.antiInitiationNode.AddDropdown(
		"Priority Type",
		["Items First", "Spells First"],
		0,
		"Select whether items or spells should take precedence when both are ready to cast"
	)

	// Items & Spells Grid Selection
	private readonly itemsSelector = this.antiInitiationNode.AddImageSelector(
		"Items Selection",
		[
			"item_sheepstick",
			"item_cyclone",
			"item_abyssal_blade",
			"item_blink",
			"item_manta",
			"item_orchid",
			"item_glimmer_cape",
			"item_hurricane_pike",
			"item_invis_sword",
			"item_heavens_halberd",
			"item_rod_of_atos"
		],
		new Map([
			["item_sheepstick", true],
			["item_cyclone", true],
			["item_abyssal_blade", true],
			["item_blink", true],
			["item_manta", true],
			["item_orchid", true],
			["item_glimmer_cape", true],
			["item_hurricane_pike", true],
			["item_invis_sword", true],
			["item_heavens_halberd", true],
			["item_rod_of_atos", true]
		]),
		"Enable or disable items for anti-initiation",
		true
	)

	private readonly spellsSelector = this.antiInitiationNode.AddImageSelector(
		"Spells Selection",
		SUPPORTED_SPELLS.map(spell => spell.name),
		new Map(SUPPORTED_SPELLS.map(spell => [spell.name, true])),
		"Enable or disable spells for anti-initiation",
		true
	)

	// Tracking states
	private readonly lastEnemyPositions = new Map<number, Vector3>()
	private readonly enemyVisibility = new Map<number, boolean>()
	private readonly antiInitSleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
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
				enabled: this.itemsSelector.IsEnabled("item_sheepstick"),
				priority: 1,
				names: ["item_sheepstick"],
				displayName: "Scythe of Vyse (Hex)",
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
				enabled: this.itemsSelector.IsEnabled("item_cyclone"),
				priority: 2,
				names: ["item_cyclone", "item_wind_waker"],
				displayName: "Eul's / Wind Waker",
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
				enabled: this.itemsSelector.IsEnabled("item_abyssal_blade"),
				priority: 3,
				names: ["item_abyssal_blade"],
				displayName: "Abyssal Blade",
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
				enabled: this.itemsSelector.IsEnabled("item_blink"),
				priority: 4,
				names: ["item_blink", "item_overwhelming_blink", "item_swift_blink", "item_arcane_blink"],
				displayName: "Blink Dagger (Escape)",
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
				enabled: this.itemsSelector.IsEnabled("item_manta"),
				priority: 5,
				names: ["item_manta"],
				displayName: "Manta Style",
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
				enabled: this.itemsSelector.IsEnabled("item_orchid"),
				priority: 6,
				names: ["item_orchid", "item_bloodthorn"],
				displayName: "Orchid / Bloodthorn",
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
				enabled: this.itemsSelector.IsEnabled("item_glimmer_cape"),
				priority: 7,
				names: ["item_glimmer_cape"],
				displayName: "Glimmer Cape",
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
				enabled: this.itemsSelector.IsEnabled("item_hurricane_pike"),
				priority: 8,
				names: ["item_hurricane_pike"],
				displayName: "Hurricane Pike",
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
				enabled: this.itemsSelector.IsEnabled("item_invis_sword"),
				priority: 9,
				names: ["item_invis_sword", "item_silver_edge"],
				displayName: "Shadow Blade / Silver Edge",
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
				enabled: this.itemsSelector.IsEnabled("item_heavens_halberd"),
				priority: 10,
				names: ["item_heavens_halberd"],
				displayName: "Heaven's Halberd",
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
				enabled: this.itemsSelector.IsEnabled("item_rod_of_atos"),
				priority: 11,
				names: ["item_rod_of_atos", "item_gungir"],
				displayName: "Atos / Gleipnir",
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
		const prioritizeSpells = this.priorityType.SelectedID === 1

		// 1. Collect Item Candidates (requires hero not to be muted, stunned, or hexed)
		if (!hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			for (const config of itemConfigs) {
				if (!config.enabled) {
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
						const inRange = isSelfCast || hero.Distance2D(enemy, true) <= castRange
						if (inRange) {
							let displayName = config.displayName
							if (item.Name === "item_cyclone") {
								displayName = "Eul's Scepter"
							} else if (item.Name === "item_wind_waker") {
								displayName = "Wind Waker"
							}
							candidates.push({
								name: displayName,
								cast: () => config.cast(item),
								priorityValue: prioritizeSpells ? config.priority + 100 : config.priority
							})
						}
					}
				}
			}
		}

		// 2. Collect Spell Candidates (requires hero not to be silenced, stunned, or hexed)
		if (!hero.IsSilenced && !hero.IsStunned && !hero.IsHexed) {
			for (let i = 0; i < SUPPORTED_SPELLS.length; i++) {
				const config = SUPPORTED_SPELLS[i]
				if (!this.spellsSelector.IsEnabled(config.name)) {
					continue
				}
				if (isTargetImmune && !config.piercesBkb) {
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
					const baseCastRange = config.castRange ?? spell.CastRange
					const castRange = baseCastRange > 0 ? baseCastRange : 600
					const inRange =
						config.castType === "position"
							? hero.Distance2D(enemy) <= castRange
							: hero.Distance2D(enemy, true) <= castRange
					if (inRange) {
						candidates.push({
							name: config.label,
							cast: () => {
								if (config.castType === "target") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
										issuers: [hero],
										target: enemy.Index,
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
								} else if (config.castType === "position") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
										issuers: [hero],
										position: enemy.Position,
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
								} else if (config.castType === "no_target") {
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
							priorityValue: prioritizeSpells ? i + 1 : i + 1 + 100
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

		const dist2D = enemy.Distance2D(hero, true)
		if (wasVisible) {
			// Check if they moved > 300 units in a single frame and landed in range
			if (lastPos && enemy.Position.Distance2D(lastPos) > 300 && dist2D <= this.antiInitRange.value) {
				triggered = true
			}
		} else if (dist2D <= this.antiInitRange.value) {
			// Sudden arrival from fog / invis
			triggered = true
		}

		// If sudden arrival toggle is off, trigger on any target in range
		if (!this.antiInitSuddenOnly.value && dist2D <= this.antiInitRange.value) {
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
				const dist = enemy.Distance2D(hero, true)
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
		for (const config of SUPPORTED_SPELLS) {
			const spell: Ability | undefined = hero.GetAbilityByName(config.name)
			if (!spell) {
				RendererSDK.Text(`  ${config.label}: NOT FOUND`, new Vector2(50, y), Color.Red)
				y += 20
				continue
			}
			const baseCastRange = config.castRange ?? spell.CastRange
			const castRange = baseCastRange > 0 ? baseCastRange : 600
			const manaEnough = hero.Mana >= spell.ManaCost
			const ready = spell.Level > 0 && spell.Cooldown <= 0.1 && manaEnough
			const enabled = this.spellsSelector.IsEnabled(config.name)
			const info = `Lvl: ${spell.Level} | CD: ${spell.Cooldown.toFixed(1)} | Mana: ${hero.Mana.toFixed(0)}/${
				spell.ManaCost
			} | Range: ${castRange} | Enabled: ${enabled} | Ready: ${ready}`
			const color = ready && enabled ? Color.Green : Color.LightGray
			RendererSDK.Text(`  ${config.label}: ${info}`, new Vector2(50, y), color)
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

	private GameEnded(): void {
		this.antiInitSleeper.ResetTimer()
		this.lastEnemyPositions.clear()
		this.enemyVisibility.clear()
	}
})()

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
	Unit,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

interface SpellConfig {
	name: string
	label: string
	piercesBkb: boolean
	castType: "target" | "position" | "no_target"
	castRange?: number
}

const INITIATION_SPELLS = [
	"axe_berserkers_call",
	"enigma_black_hole",
	"magnataur_reverse_polarity",
	"tidehunter_ravage",
	"faceless_void_chronosphere",
	"slardar_slithereen_crush",
	"centaur_hoof_stomp",
	"earthshaker_echo_slam",
	"pudge_dismember",
	"bane_fiends_grip",
	"legion_commander_duel",
	"batrider_flaming_lasso",
	"primal_beast_pulverize"
]

const INITIATION_MODIFIERS = [
	"modifier_spirit_breaker_charge_of_darkness",
	"modifier_storm_spirit_ball_lightning",
	"modifier_earth_spirit_rolling_boulder_caster",
	"modifier_primal_beast_onslaught",
	"modifier_slark_pounce"
]

const SUPPORTED_SPELLS: SpellConfig[] = [
	{ name: "lion_voodoo", label: "Lion Hex", piercesBkb: false, castType: "target" },
	{ name: "shadow_shaman_voodoo", label: "Shaman Hex", piercesBkb: false, castType: "target" },
	{ name: "rubick_telekinesis", label: "Telekinesis", piercesBkb: false, castType: "target" },
	{ name: "puck_waning_rift", label: "Waning Rift (Puck)", piercesBkb: false, castType: "no_target" },
	{ name: "lion_impale", label: "Lion Earth Spike", piercesBkb: false, castType: "position", castRange: 725 },
	{ name: "nyx_assassin_impale", label: "Impale (Nyx)", piercesBkb: false, castType: "position", castRange: 700 },
	{ name: "nyx_assassin_spiked_carapace", label: "Carapace (Nyx)", piercesBkb: true, castType: "no_target" },
	{ name: "dragon_knight_dragon_tail", label: "Dragon Tail", piercesBkb: false, castType: "target" },
	{ name: "tiny_avalanche", label: "Avalanche", piercesBkb: false, castType: "position", castRange: 600 },
	{ name: "jakiro_ice_path", label: "Ice Path", piercesBkb: false, castType: "position", castRange: 1200 },
	{ name: "shadow_shaman_shackles", label: "Shackles", piercesBkb: false, castType: "target" },
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
	{ name: "silencer_last_word", label: "Last Word (Silencer)", piercesBkb: false, castType: "target" },
	{ name: "silencer_global_silence", label: "Global Silence", piercesBkb: true, castType: "no_target" },
	{ name: "treant_overgrowth", label: "Overgrowth (Treant)", piercesBkb: true, castType: "no_target" },
	{ name: "riki_smoke_screen", label: "Smoke Screen", piercesBkb: false, castType: "position", castRange: 550 },
	{ name: "drow_ranger_wave_of_silence", label: "Gust", piercesBkb: false, castType: "position", castRange: 900 },
	{ name: "bane_fiends_grip", label: "Fiend's Grip", piercesBkb: true, castType: "target" },
	{ name: "beastmaster_primal_roar", label: "Primal Roar", piercesBkb: true, castType: "target" },
	{ name: "doom_bringer_doom", label: "Doom", piercesBkb: true, castType: "target" },
	{ name: "legion_commander_duel", label: "Duel", piercesBkb: true, castType: "target" },
	{ name: "necrolyte_reapers_scythe", label: "Reaper's Scythe", piercesBkb: true, castType: "target" },
	{ name: "earthshaker_fissure", label: "Fissure", piercesBkb: false, castType: "position", castRange: 1400 },
	{ name: "earthshaker_echo_slam", label: "Echo Slam", piercesBkb: true, castType: "no_target", castRange: 600 },
	{ name: "tusk_walrus_kick", label: "Walrus Kick", piercesBkb: true, castType: "target", castRange: 250 },
	{ name: "tusk_walrus_punch", label: "Walrus PUNCH!", piercesBkb: true, castType: "target", castRange: 150 },
	{ name: "tiny_toss", label: "Toss (Tiny)", piercesBkb: true, castType: "target", castRange: 900 },
	{ name: "zuus_lightning_bolt", label: "Lightning Bolt (Zeus)", piercesBkb: false, castType: "target" },
	{ name: "muerta_dead_shot", label: "Dead Shot (Muerta)", piercesBkb: false, castType: "target" },
	{
		name: "tinker_warp_grenade",
		label: "Warp Grenade (Tinker)",
		piercesBkb: false,
		castType: "target",
		castRange: 700
	},
	{
		name: "pudge_dismember",
		label: "Dismember (Pudge)",
		piercesBkb: true,
		castType: "target",
		castRange: 160
	},
	{
		name: "sniper_concussive_grenade",
		label: "Concussive Grenade (Sniper)",
		piercesBkb: false,
		castType: "position",
		castRange: 900
	}
]

new (class AntiInitiationUtility {
	private readonly entry = Menu.AddEntry("mm44x")

	// Anti Initiation Nodes
	private readonly antiInitiationNode = this.entry.AddNode("Anti Initiation")
	private readonly antiInitEnabled = this.antiInitiationNode.AddToggle(
		"Enabled",
		true,
		"Master toggle for Anti-Initiation"
	)
	private readonly antiInitRange = this.antiInitiationNode.AddSlider("Trigger Range", 500, 200, 900)
	private readonly antiInitSuddenOnly = this.antiInitiationNode.AddToggle(
		"Only on Sudden Arrival / Rush",
		true,
		"Trigger on Blink, Fog ambush, Charge, or incoming initiation spells"
	)
	private readonly checkCastPhase = this.antiInitiationNode.AddToggle(
		"Interrupt Cast Phase Initiation",
		true,
		"Instantly disable enemy casting Call, Black Hole, RP, Ravage, etc."
	)
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
			"item_abyssal_blade",
			"item_cyclone",
			"item_wind_waker",
			"item_blink",
			"item_manta",
			"item_orchid",
			"item_heavens_halberd",
			"item_rod_of_atos",
			"item_glimmer_cape",
			"item_hurricane_pike",
			"item_invis_sword"
		],
		new Map([
			["item_sheepstick", true],
			["item_abyssal_blade", true],
			["item_cyclone", true],
			["item_wind_waker", true],
			["item_blink", true],
			["item_manta", true],
			["item_orchid", true],
			["item_heavens_halberd", true],
			["item_rod_of_atos", true],
			["item_glimmer_cape", true],
			["item_hurricane_pike", true],
			["item_invis_sword", true]
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

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined && LocalPlayer.Hero.IsValid === true
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
						claimOrder()
					}
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_abyssal_blade"),
				priority: 2,
				names: ["item_abyssal_blade"],
				displayName: "Abyssal Blade (BKB Pierce)",
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
						claimOrder()
					}
				}
			},
			{
				enabled:
					this.itemsSelector.IsEnabled("item_cyclone") || this.itemsSelector.IsEnabled("item_wind_waker"),
				priority: 3,
				names: ["item_cyclone", "item_wind_waker"],
				displayName: "Eul's / Wind Waker",
				piercesBkb: true,
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
					claimOrder()
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
					claimOrder()
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
					claimOrder()
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
						claimOrder()
					}
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_heavens_halberd"),
				priority: 7,
				names: ["item_heavens_halberd"],
				displayName: "Heaven's Halberd (Disarm)",
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
						claimOrder()
					}
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_rod_of_atos"),
				priority: 8,
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
							claimOrder()
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
						claimOrder()
					}
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_glimmer_cape"),
				priority: 9,
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
					claimOrder()
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_hurricane_pike"),
				priority: 10,
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
						claimOrder()
					}
				}
			},
			{
				enabled: this.itemsSelector.IsEnabled("item_invis_sword"),
				priority: 11,
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
					claimOrder()
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

		// 1. Collect Item Candidates
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
								displayName = isEulSelfCast ? "Eul's Scepter (Self-Save)" : "Eul's Scepter"
							} else if (item.Name === "item_wind_waker") {
								displayName = isEulSelfCast ? "Wind Waker (Self-Save)" : "Wind Waker"
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

		// 2. Collect Spell Candidates
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
							: config.castType === "no_target"
							? hero.Distance2D(enemy, true) <= (config.castRange ?? 450)
							: hero.Distance2D(enemy, true) <= castRange

					if (inRange) {
						if (config.name === "tiny_toss") {
							const grabRadius = 275
							let hasGrabUnit = false
							for (const unit of EntityManager.GetEntitiesByClass(Unit)) {
								if (
									unit.IsValid &&
									unit.IsAlive &&
									unit !== hero &&
									hero.Distance2D(unit) <= grabRadius
								) {
									hasGrabUnit = true
									break
								}
							}
							if (!hasGrabUnit) {
								continue
							}
						}

						candidates.push({
							name: config.label,
							cast: () => {
								if (config.castType === "target") {
									if (config.name === "tusk_walrus_kick") {
										let kickTarget: Unit | undefined
										let minAllyDist = Infinity
										for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
											if (
												ally.IsValid &&
												ally.IsAlive &&
												ally !== hero &&
												!ally.IsEnemy(hero) &&
												!ally.IsIllusion
											) {
												const dist = hero.Distance2D(ally)
												if (dist < minAllyDist) {
													minAllyDist = dist
													kickTarget = ally
												}
											}
										}
										if (!kickTarget) {
											kickTarget = EntityManager.GetEntitiesByClass(Fountain).find(
												f => f.IsValid && !f.IsEnemy(hero)
											)
										}
										if (kickTarget) {
											const kickDirection = kickTarget.Position
											ExecuteOrder.PrepareOrder({
												orderType: dotaunitorder_t.DOTA_UNIT_ORDER_VECTOR_TARGET_POSITION,
												issuers: [hero],
												ability: spell.Index,
												target: enemy.Index,
												position: kickDirection,
												queue: false,
												showEffects: true,
												isPlayerInput: false
											})
											claimOrder()
											return
										}
									}

									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
										issuers: [hero],
										target: enemy.Index,
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
									claimOrder()
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
									claimOrder()
								} else if (config.castType === "no_target") {
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
										issuers: [hero],
										ability: spell.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
									claimOrder()
								}
							},
							priorityValue: prioritizeSpells ? i + 1 : i + 1 + 100
						})
					}
				}
			}
		}

		candidates.sort((a, b) => a.priorityValue - b.priorityValue)
		return candidates
	}

	private checkAndCastAntiInitiation(hero: Hero, enemy: Hero): void {
		const wasVisible = this.enemyVisibility.get(enemy.Index) ?? false
		const lastPos = this.lastEnemyPositions.get(enemy.Index)
		let triggered = false

		const dist2D = enemy.Distance2D(hero, true)
		const triggerRange = this.antiInitRange.value

		// 1. Blink / Sudden Teleport arrival (>300 units in 1 frame)
		if (wasVisible) {
			if (lastPos && enemy.Position.Distance2D(lastPos) > 300 && dist2D <= triggerRange) {
				triggered = true
			}
		} else if (dist2D <= triggerRange) {
			// Sudden arrival from Fog / Invisibility
			triggered = true
		}

		// 2. High-Speed Movement & Charge Inisiasi (Spirit Breaker Charge, Storm Ball, Primal Beast Onslaught, Slark Pounce)
		if (!triggered && dist2D <= triggerRange) {
			const hasInitiationModifier = INITIATION_MODIFIERS.some(mod => enemy.HasBuffByName(mod))
			if (hasInitiationModifier) {
				triggered = true
			}
		}

		// 3. Cast Phase Initiation Check (Interrupting Axe Call, Enigma Black Hole, Magnus RP, Ravage, etc.)
		if (!triggered && this.checkCastPhase.value && dist2D <= triggerRange + 150) {
			const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
			for (const spell of spells) {
				if (spell.IsInAbilityPhase && INITIATION_SPELLS.includes(spell.Name)) {
					triggered = true
					break
				}
			}
		}

		// 4. Any Target in range if sudden only toggle is disabled
		if (!this.antiInitSuddenOnly.value && dist2D <= triggerRange) {
			triggered = true
		}

		if (!triggered) {
			return
		}

		// Skip if target is already disabled (Stunned, Hexed, Nightmared, or Cycloned)
		if (
			enemy.IsStunned ||
			enemy.IsHexed ||
			enemy.IsNightmared ||
			enemy.HasBuffByName("modifier_eul_cyclone") ||
			enemy.HasBuffByName("modifier_wind_waker")
		) {
			return
		}

		const isTargetImmune = enemy.IsMagicImmune || enemy.IsDebuffImmune
		const candidates = this.getCandidates(hero, enemy, isTargetImmune)

		if (candidates.length === 0) {
			return
		}

		// Execute the highest priority counter
		candidates[0].cast()

		const delay = GameState.InputLag * 1000 + Math.randomRange(40, 100)
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

		const x = 50
		let y = 180
		const padX = 8
		const padY = 6
		const textH = RendererSDK.DefaultTextSize

		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			h => h && h.IsValid && h.IsEnemy(hero) && !h.IsIllusion && h.IsVisible && h.IsAlive
		)

		const lines: { text: string; color: Color }[] = [
			{
				text: `[Anti Initiation] ${this.antiInitEnabled.value ? "ACTIVE" : "DISABLED"} | Range: ${
					this.antiInitRange.value
				}`,
				color: Color.Yellow
			}
		]

		if (enemies.length === 0) {
			lines.push({ text: "  No visible enemies in vision", color: Color.LightGray })
		} else {
			for (const enemy of enemies) {
				const dist = enemy.Distance2D(hero, true)
				const isInitiating =
					INITIATION_MODIFIERS.some(m => enemy.HasBuffByName(m)) ||
					enemy.Spells.some(s => s?.IsInAbilityPhase && INITIATION_SPELLS.includes(s.Name))
				lines.push({
					text: `  Enemy: ${enemy.Name} | Dist: ${dist.toFixed(0)} | Threat: ${
						isInitiating ? "INITIATING!" : "Normal"
					}`,
					color: isInitiating ? Color.Red : dist <= this.antiInitRange.value ? Color.Yellow : Color.White
				})
			}
		}

		const testEnemy = enemies[0]
		if (testEnemy) {
			const isTargetImmune = testEnemy.IsMagicImmune || testEnemy.IsDebuffImmune
			const candidates = this.getCandidates(hero, testEnemy, isTargetImmune)
			if (candidates.length > 0) {
				lines.push({ text: `  Ready Counter: ${candidates[0].name}`, color: Color.Green })
			}
		}

		let maxW = 0
		for (const line of lines) {
			const sz = RendererSDK.GetTextSize(line.text, RendererSDK.DefaultFontName, RendererSDK.DefaultTextSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const rectW = maxW + padX * 2
		const rectH = lines.length * textH + padY * 2

		RendererSDK.FilledRect(new Vector2(x - padX, y - padY), new Vector2(rectW, rectH), new Color(0, 0, 0, 220))
		RendererSDK.OutlinedRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			1.5,
			new Color(0, 200, 255, 200)
		)

		for (const line of lines) {
			RendererSDK.Text(line.text, new Vector2(x, y), line.color)
			y += textH
		}
	}

	private GameEnded(): void {
		this.antiInitSleeper.ResetTimer()
		this.lastEnemyPositions.clear()
		this.enemyVisibility.clear()
	}
})()

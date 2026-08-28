import {
	Ability,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	Item,
	LocalPlayer,
	Menu,
	ProjectileManager,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

const FATAL_MODIFIERS = [
	"modifier_legion_commander_duel",
	"modifier_necrolyte_reapers_scythe",
	"modifier_bane_fiends_grip",
	"modifier_batrider_flaming_lasso",
	"modifier_shadow_shaman_shackles",
	"modifier_enigma_black_hole_pull",
	"modifier_faceless_void_chronosphere_freeze",
	"modifier_winter_wyvern_winters_curse",
	"modifier_winter_wyvern_winters_curse_aura",
	"modifier_axe_berserkers_call",
	"modifier_magnus_reverse_polarity",
	"modifier_doom_bringer_doom",
	"modifier_pudge_dismember",
	"modifier_primal_beast_pulverize",
	"modifier_ice_blast",
	"modifier_witch_doctor_maledict"
]

const LOTUS_DEBUFFS = [
	"modifier_bounty_hunter_track",
	"modifier_slardar_corrosive_haze",
	"modifier_spirit_breaker_charge_of_darkness_vision"
]

const THREAT_MODIFIERS = [
	"modifier_lion_voodoo",
	"modifier_shadow_shaman_voodoo",
	"modifier_shadow_shaman_shackles",
	"modifier_orchid_malevolence_debuff",
	"modifier_bloodthorn_debuff",
	"modifier_sheepstick_debuff",
	"modifier_basher",
	"modifier_item_nullifier_mute",
	"modifier_item_nullifier",
	"modifier_legion_commander_duel",
	"modifier_necrolyte_reapers_scythe",
	"modifier_bane_fiends_grip",
	"modifier_batrider_flaming_lasso",
	"modifier_pudge_dismember",
	"modifier_primal_beast_pulverize",
	"modifier_axe_berserkers_call",
	"modifier_bounty_hunter_track",
	"modifier_slardar_corrosive_haze",
	"modifier_spirit_breaker_charge_of_darkness_vision",
	"modifier_bane_nightmare",
	"modifier_stunned",
	"modifier_hexed",
	"modifier_silence"
]

const THREAT_ABILITIES = [
	"lion_voodoo",
	"lion_impale",
	"lion_finger_of_death",
	"shadow_shaman_voodoo",
	"shadow_shaman_shackles",
	"vengefulspirit_magic_missile",
	"vengefulspirit_nether_swap",
	"necrolyte_reapers_scythe",
	"bane_fiends_grip",
	"doom_bringer_doom",
	"axe_berserkers_call",
	"batrider_flaming_lasso",
	"pudge_dismember",
	"primal_beast_pulverize",
	"slardar_corrosive_haze",
	"bounty_hunter_track",
	"spirit_breaker_charge_of_darkness",
	"legion_commander_duel",
	"bane_nightmare",
	"invoker_chaos_meteor",
	"invoker_deafening_blast",
	"invoker_sun_strike",
	"lina_laguna_blade",
	"skywrath_mage_mystic_flare",
	"huskar_life_break"
]

const THREAT_ITEMS = ["item_orchid", "item_bloodthorn", "item_sheepstick", "item_abyssal_blade", "item_nullifier"]

const REFLECTABLE_SPELLS = [
	"bounty_hunter_track",
	"slardar_corrosive_haze",
	"spirit_breaker_charge_of_darkness",
	"vengefulspirit_magic_missile",
	"vengefulspirit_nether_swap",
	"lion_voodoo",
	"lion_finger_of_death",
	"shadow_shaman_voodoo",
	"shadow_shaman_shackles",
	"necrolyte_reapers_scythe",
	"bane_fiends_grip",
	"bane_brain_sap",
	"bane_nightmare",
	"batrider_flaming_lasso",
	"pudge_dismember",
	"doom_bringer_doom",
	"lina_laguna_blade",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_abyssal_blade",
	"item_nullifier",
	"item_dagon",
	"item_dagon_2",
	"item_dagon_3",
	"item_dagon_4",
	"item_dagon_5"
]

const INSTANT_REFLECTABLE_SPELLS = [
	"lion_voodoo",
	"shadow_shaman_voodoo",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_abyssal_blade"
]

const MAGIC_THREAT_ABILITIES = [
	"lion_voodoo",
	"lion_impale",
	"shadow_shaman_voodoo",
	"shadow_shaman_shackles",
	"vengefulspirit_magic_missile",
	"necrolyte_reapers_scythe",
	"doom_bringer_doom",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_nullifier",
	"lina_laguna_blade",
	"skywrath_mage_mystic_flare",
	"invoker_chaos_meteor",
	"invoker_sun_strike",
	"invoker_deafening_blast"
]

const MAGIC_THREAT_MODIFIERS = [
	"modifier_lion_voodoo",
	"modifier_shadow_shaman_voodoo",
	"modifier_shadow_shaman_shackles",
	"modifier_orchid_malevolence_debuff",
	"modifier_bloodthorn_debuff",
	"modifier_sheepstick_debuff",
	"modifier_necrolyte_reapers_scythe",
	"modifier_doom_bringer_doom",
	"modifier_item_nullifier_mute",
	"modifier_item_nullifier"
]

new (class AutoSaveUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("Auto Save (Ally & Team)")
	private readonly enabled = this.node.AddToggle("Enabled", true, "Master toggle for Auto Save")

	private readonly priority = this.node.AddDropdown(
		"Save Priority",
		["Team First (Protect Core/Allies)", "Self First"],
		0
	)

	private readonly teamFilterNode = this.node.AddNode("Ally Target Filter", "menu/icons/dazzle.svg")
	private teamSelector?: Menu.ImageSelector

	// Hero Spells settings
	private readonly heroSpellsNode = this.node.AddNode("Hero Spells")
	private readonly heroSpellsSelector = this.heroSpellsNode.AddImageSelector(
		"Hero Spells Selection",
		[
			"dazzle_shallow_grave",
			"oracle_false_promise",
			"oracle_fates_edict",
			"ringmaster_the_box",
			"shadow_demon_disruption",
			"obsidian_destroyer_astral_imprisonment",
			"winter_wyvern_cold_embrace",
			"abaddon_aphotic_shield",
			"legion_commander_press_the_attack",
			"omniknight_purification",
			"omniknight_repel",
			"pugna_decrepify",
			"vengefulspirit_nether_swap",
			"tusk_snowball",
			"lich_frost_shield",
			"treant_living_armor",
			"weaver_time_lapse"
		],
		new Map([
			["dazzle_shallow_grave", true],
			["oracle_false_promise", true],
			["oracle_fates_edict", true],
			["ringmaster_the_box", true],
			["shadow_demon_disruption", true],
			["obsidian_destroyer_astral_imprisonment", true],
			["winter_wyvern_cold_embrace", true],
			["abaddon_aphotic_shield", true],
			["legion_commander_press_the_attack", true],
			["omniknight_purification", true],
			["omniknight_repel", true],
			["pugna_decrepify", true],
			["vengefulspirit_nether_swap", true],
			["tusk_snowball", true],
			["lich_frost_shield", true],
			["treant_living_armor", true],
			["weaver_time_lapse", true]
		]),
		"Enable or disable specific hero spells for ally saving",
		true
	)
	private readonly heroFatal = this.heroSpellsNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly heroLowHP = this.heroSpellsNode.AddToggle("Save on Low HP", true)
	private readonly heroOnlyDanger = this.heroSpellsNode.AddToggle("Only Save if in Danger", true)
	private readonly heroMinHP = this.heroSpellsNode.AddSlider("Save on HP %", 20, 1, 99)

	// Items settings
	private readonly itemsNode = this.node.AddNode("Save Items")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Items Selection",
		[
			"item_lotus_orb",
			"item_glimmer_cape",
			"item_force_staff",
			"item_solar_crest",
			"item_pavise",
			"item_holy_locket",
			"item_mekansm",
			"item_guardian_greaves",
			"item_wind_waker",
			"item_ethereal_blade",
			"item_sphere"
		],
		new Map([
			["item_lotus_orb", true],
			["item_glimmer_cape", true],
			["item_force_staff", true],
			["item_solar_crest", true],
			["item_pavise", true],
			["item_holy_locket", true],
			["item_mekansm", true],
			["item_guardian_greaves", true],
			["item_wind_waker", true],
			["item_ethereal_blade", true],
			["item_sphere", true]
		]),
		"Enable or disable specific items for ally/team saving",
		true
	)

	// Lotus Orb settings
	private readonly lotusNode = this.itemsNode.AddNode("Lotus Orb")
	private readonly lotusDebuffs = this.lotusNode.AddToggle("Save on Track/Armor Debuffs", true)
	private readonly lotusSilence = this.lotusNode.AddToggle("Save on Silence", true)
	private readonly lotusRoot = this.lotusNode.AddToggle("Save on Root", true)
	private readonly lotusOnlyDanger = this.lotusNode.AddToggle("Only Save if in Danger", true)
	private readonly lotusPredictInstant = this.lotusNode.AddToggle("Predict Instant Spells", true)

	// Ethereal Blade settings
	private readonly ebladeNode = this.itemsNode.AddNode("Ethereal Blade")
	private readonly ebladeFatal = this.ebladeNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly ebladeDuelTarget = this.ebladeNode.AddDropdown(
		"Fatal Debuff Target",
		["Affected Ally", "Enemy Caster"],
		0
	)
	private readonly ebladeLowHP = this.ebladeNode.AddToggle("Save on Low HP", true)
	private readonly ebladeOnlyDanger = this.ebladeNode.AddToggle("Only Save if in Danger", true)
	private readonly ebladeMinHP = this.ebladeNode.AddSlider("Save on HP %", 20, 1, 99)

	// Mekansm & Greaves settings
	private readonly mekGreavesNode = this.itemsNode.AddNode("Mekansm & Greaves")
	private readonly mekGreavesLowHP = this.mekGreavesNode.AddToggle("Save on Low HP", true)
	private readonly mekGreavesOnlyDanger = this.mekGreavesNode.AddToggle("Only Save if in Danger", true)
	private readonly mekGreavesMinHP = this.mekGreavesNode.AddSlider("Save on HP %", 25, 1, 99)
	private readonly greavesAutoDispel = this.mekGreavesNode.AddToggle("Auto-Dispel Self", true)

	// Wind Waker settings
	private readonly wwNode = this.itemsNode.AddNode("Wind Waker")
	private readonly wwAllySave = this.wwNode.AddToggle("Wind Waker Save Allies", true)

	private readonly castSleeper = new TickSleeper()

	private executeAndClaimOrder(castFn: () => void, delay: number): void {
		castFn()
		claimOrder()
		this.castSleeper.Sleep(delay)
	}

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
	}

	private getOrderedAllies(hero: Hero, allHeroes: Hero[]): Hero[] {
		const allies = allHeroes.filter(h => h && h.IsValid && h.IsAlive && !h.IsIllusion && !h.IsEnemy(hero))

		if (!this.teamSelector) {
			this.teamSelector = this.teamFilterNode.AddImageSelector(
				"Filter Allies",
				[],
				new Map(),
				"Disable allies you don't want to auto-save",
				true
			)
		}

		for (const ally of allies) {
			const name = ally.Name
			if (!this.teamSelector.values.includes(name)) {
				this.teamSelector.values.push(name)
				this.teamSelector.enabledValues.set(name, true)
			}
		}

		const allowed = allies.filter(ally => {
			if (this.teamSelector && !this.teamSelector.IsEnabled(ally.Name)) {
				return false
			}
			return true
		})

		const isSelfFirst = this.priority.SelectedID === 1
		const self = allowed.find(a => a === hero)
		const team = allowed.filter(a => a !== hero)

		return isSelfFirst ? (self ? [self, ...team] : team) : self ? [...team, self] : team
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined && LocalPlayer.Hero.IsValid === true
	}

	private hasFatalDebuff(unit: Hero): boolean {
		return FATAL_MODIFIERS.some(mod => unit.HasBuffByName(mod))
	}

	private hasActiveSaveOrImmunity(unit: Hero): boolean {
		const saveModifiers = [
			"modifier_dazzle_shallow_grave",
			"modifier_item_aeon_disk_buff",
			"modifier_abaddon_borrowed_time",
			"modifier_oracle_false_promise",
			"modifier_troll_warlord_battle_trance",
			"modifier_troll_warlord_battle_trance_ally",
			"modifier_ringmaster_the_box_buff",
			"modifier_shadow_demon_disruption",
			"modifier_obsidian_destroyer_astral_imprisonment",
			"modifier_winter_wyvern_cold_embrace",
			"modifier_nyx_assassin_spiked_carapace",
			"modifier_eul_cyclone",
			"modifier_wind_waker"
		]
		return saveModifiers.some(mod => unit.HasBuffByName(mod))
	}

	private isTargetInDanger(
		unit: Hero,
		minHP: number,
		onlySaveInDanger: boolean,
		allHeroes: Hero[],
		_localHero: Hero
	): boolean {
		if (unit.HPPercent > minHP) {
			return false
		}
		if (!onlySaveInDanger) {
			return true
		}
		if (unit.HPPercent <= 5) {
			return true
		}
		if (unit.IsStunned || unit.IsHexed || unit.IsNightmared || unit.IsSilenced) {
			return true
		}
		if (unit.HasBuffByName("modifier_ice_blast") || unit.HasBuffByName("modifier_witch_doctor_maledict")) {
			return true
		}
		const enemyNearby = allHeroes.some(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(unit) &&
				!h.IsIllusion &&
				(unit.Distance2D(h, true) <= 1000 ||
					(h.IsAttacking && h.Distance2D(unit, true) <= h.GetAttackRange(unit) + 200))
		)
		return enemyNearby
	}

	private hasActiveThreatModifier(target: Hero): boolean {
		return THREAT_MODIFIERS.some(mod => {
			if (mod === "modifier_spirit_breaker_charge_of_darkness_vision") {
				if (!target.HasBuffByName(mod)) {
					return false
				}
				const sb = EntityManager.GetEntitiesByClass(Hero).find(
					h =>
						h &&
						h.IsValid &&
						h.IsAlive &&
						h.IsEnemy(target) &&
						h.Name === "npc_dota_hero_spirit_breaker" &&
						!h.IsIllusion
				)
				if (sb && sb.Distance2D(target, true) > 1000) {
					return false
				}
				return true
			}
			return target.HasBuffByName(mod)
		})
	}

	private isAboutToBeTargetedByThreat(target: Hero, allHeroes: Hero[]): boolean {
		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Ability) {
				const name = proj.Ability.Name
				if (THREAT_ABILITIES.includes(name) || THREAT_ITEMS.includes(name)) {
					return true
				}
			}
		}

		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				const items = enemy.HasInventory ? enemy.Items.filter((i): i is Item => i !== undefined) : []
				const abilities = [...spells, ...items]

				for (const abil of abilities) {
					if (
						abil.IsInAbilityPhase &&
						(THREAT_ABILITIES.includes(abil.Name) || THREAT_ITEMS.includes(abil.Name))
					) {
						if (enemy.FindRotationAngle(target) < 0.25) {
							let castRange = abil.CastRange > 0 ? abil.CastRange : 600
							if (abil.Name === "spirit_breaker_charge_of_darkness") {
								castRange = 1000
							}
							if (enemy.Distance2D(target, true) <= castRange + 150) {
								return true
							}
						}
					}
				}
			}
		}

		return false
	}

	private isAboutToBeTargetedByReflectableThreat(target: Hero, allHeroes: Hero[]): boolean {
		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Ability) {
				if (REFLECTABLE_SPELLS.includes(proj.Ability.Name)) {
					return true
				}
			}
		}

		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				const items = enemy.HasInventory ? enemy.Items.filter((i): i is Item => i !== undefined) : []
				const abilities = [...spells, ...items]

				for (const abil of abilities) {
					if (abil.IsInAbilityPhase && REFLECTABLE_SPELLS.includes(abil.Name)) {
						if (enemy.FindRotationAngle(target) < 0.25) {
							let castRange = abil.CastRange > 0 ? abil.CastRange : 600
							if (abil.Name === "spirit_breaker_charge_of_darkness") {
								castRange = 1000
							}
							if (enemy.Distance2D(target, true) <= castRange + 150) {
								return true
							}
						}
					}

					if (this.lotusPredictInstant.value && INSTANT_REFLECTABLE_SPELLS.includes(abil.Name)) {
						const isReady =
							(abil.Level > 0 || abil instanceof Item) && abil.Cooldown <= 0.1 && enemy.IsManaEnough(abil)
						if (isReady) {
							if (enemy.FindRotationAngle(target) < 0.15) {
								const castRange = abil.CastRange > 0 ? abil.CastRange : 600
								if (enemy.Distance2D(target, true) <= castRange + 50) {
									return true
								}
							}
						}
					}
				}
			}
		}

		return false
	}

	private isUnderOrTargetedByMagicThreat(target: Hero, allHeroes: Hero[]): boolean {
		const hasMagicModifier = MAGIC_THREAT_MODIFIERS.some(mod => target.HasBuffByName(mod))
		if (hasMagicModifier) {
			return true
		}

		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Ability) {
				if (MAGIC_THREAT_ABILITIES.includes(proj.Ability.Name)) {
					return true
				}
			}
		}

		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				const items = enemy.HasInventory ? enemy.Items.filter((i): i is Item => i !== undefined) : []
				const abilities = [...spells, ...items]

				for (const abil of abilities) {
					if (abil.IsInAbilityPhase && MAGIC_THREAT_ABILITIES.includes(abil.Name)) {
						if (enemy.FindRotationAngle(target) < 0.25) {
							const castRange = abil.CastRange > 0 ? abil.CastRange : 600
							if (enemy.Distance2D(target, true) <= castRange + 150) {
								return true
							}
						}
					}
				}
			}
		}

		return false
	}

	private getEnemyCasterOfThreat(target: Hero, allHeroes: Hero[]): Hero | undefined {
		const LC = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_legion_commander" &&
				!h.IsIllusion
		)
		if (target.HasBuffByName("modifier_legion_commander_duel") && LC) {
			return LC
		}

		const Necro = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_necrolyte" &&
				!h.IsIllusion
		)
		if (target.HasBuffByName("modifier_necrolyte_reapers_scythe") && Necro) {
			return Necro
		}

		const Bane = allHeroes.find(
			h => h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_bane" && !h.IsIllusion
		)
		if (target.HasBuffByName("modifier_bane_fiends_grip") && Bane) {
			return Bane
		}

		const Batrider = allHeroes.find(
			h =>
				h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_batrider" && !h.IsIllusion
		)
		if (target.HasBuffByName("modifier_batrider_flaming_lasso") && Batrider) {
			return Batrider
		}

		const SS = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_shadow_shaman" &&
				!h.IsIllusion
		)
		if (
			(target.HasBuffByName("modifier_shadow_shaman_shackles") ||
				target.HasBuffByName("modifier_shadow_shaman_voodoo")) &&
			SS
		) {
			return SS
		}

		return undefined
	}

	private shouldSaveTarget(
		target: Hero,
		allHeroes: Hero[],
		localHero: Hero,
		minHP: number,
		onlySaveInDanger: boolean,
		lowHPEnabled: boolean,
		fatalEnabled: boolean
	): boolean {
		if (this.hasActiveSaveOrImmunity(target)) {
			return false
		}

		if (fatalEnabled) {
			if (
				this.hasFatalDebuff(target) ||
				this.hasActiveThreatModifier(target) ||
				this.isAboutToBeTargetedByThreat(target, allHeroes)
			) {
				return true
			}
		}

		if (lowHPEnabled) {
			if (this.isTargetInDanger(target, minHP, onlySaveInDanger, allHeroes, localHero)) {
				return true
			}
		}

		return false
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (hero === undefined || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.enabled.value || this.castSleeper.Sleeping) {
			return
		}

		if (hero.IsChanneling) {
			return
		}

		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		const orderedAllies = this.getOrderedAllies(hero, allHeroes)
		const delay = GameState.InputLag * 1000 + Math.randomRange(50, 100)

		// -------------------------------------------------------------
		// 1. HERO LIFESAVING SPELLS
		// -------------------------------------------------------------

		// 1a. Dazzle Shallow Grave
		if (
			this.heroSpellsSelector.IsEnabled("dazzle_shallow_grave") &&
			hero.Name === "npc_dota_hero_dazzle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const grave = hero.GetAbilityByName("dazzle_shallow_grave")
			if (grave && grave.IsValid && grave.Level > 0 && grave.Cooldown <= 0.1 && hero.IsManaEnough(grave)) {
				const castRange = grave.CastRange > 0 ? grave.CastRange : 800
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(grave, target), delay)
							return
						}
					}
				}
			}
		}

		// 1b. Oracle False Promise
		if (
			this.heroSpellsSelector.IsEnabled("oracle_false_promise") &&
			hero.Name === "npc_dota_hero_oracle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const promise = hero.GetAbilityByName("oracle_false_promise")
			if (
				promise &&
				promise.IsValid &&
				promise.Level > 0 &&
				promise.Cooldown <= 0.1 &&
				hero.IsManaEnough(promise)
			) {
				const castRange = promise.CastRange > 0 ? promise.CastRange : 800
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(promise, target), delay)
							return
						}
					}
				}
			}
		}

		// 1c. Oracle Fate's Edict (100% Magic Resistance on Ally under Magic Burst / Scythe)
		if (
			this.heroSpellsSelector.IsEnabled("oracle_fates_edict") &&
			hero.Name === "npc_dota_hero_oracle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const edict = hero.GetAbilityByName("oracle_fates_edict")
			if (edict && edict.IsValid && edict.Level > 0 && edict.Cooldown <= 0.1 && hero.IsManaEnough(edict)) {
				const castRange = edict.CastRange > 0 ? edict.CastRange : 800
				for (const target of orderedAllies) {
					if (
						this.isUnderOrTargetedByMagicThreat(target, allHeroes) &&
						!this.hasActiveSaveOrImmunity(target)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(edict, target), delay)
							return
						}
					}
				}
			}
		}

		// 1d. Ringmaster The Box (Escape Act)
		if (
			this.heroSpellsSelector.IsEnabled("ringmaster_the_box") &&
			hero.Name === "npc_dota_hero_ringmaster" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const box = hero.GetAbilityByName("ringmaster_the_box")
			if (box && box.IsValid && box.Level > 0 && box.Cooldown <= 0.1 && hero.IsManaEnough(box)) {
				const castRange = box.CastRange > 0 ? box.CastRange : 600
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(box, target), delay)
							return
						}
					}
				}
			}
		}

		// 1e. Shadow Demon Disruption
		if (
			this.heroSpellsSelector.IsEnabled("shadow_demon_disruption") &&
			hero.Name === "npc_dota_hero_shadow_demon" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const disruption = hero.GetAbilityByName("shadow_demon_disruption")
			if (
				disruption &&
				disruption.IsValid &&
				disruption.Level > 0 &&
				disruption.Cooldown <= 0.1 &&
				hero.IsManaEnough(disruption)
			) {
				const castRange = disruption.CastRange > 0 ? disruption.CastRange : 600
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(disruption, target), delay)
							return
						}
					}
				}
			}
		}

		// 1f. OD Astral Imprisonment
		if (
			this.heroSpellsSelector.IsEnabled("obsidian_destroyer_astral_imprisonment") &&
			hero.Name === "npc_dota_hero_obsidian_destroyer" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const astral = hero.GetAbilityByName("obsidian_destroyer_astral_imprisonment")
			if (astral && astral.IsValid && astral.Level > 0 && astral.Cooldown <= 0.1 && hero.IsManaEnough(astral)) {
				const castRange = astral.CastRange > 0 ? astral.CastRange : 650
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(astral, target), delay)
							return
						}
					}
				}
			}
		}

		// 1g. Winter Wyvern Cold Embrace
		if (
			this.heroSpellsSelector.IsEnabled("winter_wyvern_cold_embrace") &&
			hero.Name === "npc_dota_hero_winter_wyvern" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const embrace = hero.GetAbilityByName("winter_wyvern_cold_embrace")
			if (
				embrace &&
				embrace.IsValid &&
				embrace.Level > 0 &&
				embrace.Cooldown <= 0.1 &&
				hero.IsManaEnough(embrace)
			) {
				const castRange = embrace.CastRange > 0 ? embrace.CastRange : 850
				for (const target of orderedAllies) {
					if (!this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
						if (
							this.shouldSaveTarget(
								target,
								allHeroes,
								hero,
								this.heroMinHP.value,
								this.heroOnlyDanger.value,
								this.heroLowHP.value,
								this.heroFatal.value
							)
						) {
							if (hero.Distance2D(target, true) <= castRange) {
								this.executeAndClaimOrder(() => hero.CastTarget(embrace, target), delay)
								return
							}
						}
					}
				}
			}
		}

		// 1h. Abaddon Aphotic Shield
		if (
			this.heroSpellsSelector.IsEnabled("abaddon_aphotic_shield") &&
			hero.Name === "npc_dota_hero_abaddon" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const shield = hero.GetAbilityByName("abaddon_aphotic_shield")
			if (shield && shield.IsValid && shield.Level > 0 && shield.Cooldown <= 0.1 && hero.IsManaEnough(shield)) {
				const castRange = shield.CastRange > 0 ? shield.CastRange : 500
				for (const target of orderedAllies) {
					if (target.HasBuffByName("modifier_abaddon_aphotic_shield")) {
						continue
					}
					const needsDispel = target.IsStunned || target.IsHexed || target.IsRooted || target.IsSilenced
					if (
						needsDispel ||
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(shield, target), delay)
							return
						}
					}
				}
			}
		}

		// 1i. Legion Commander Press The Attack
		if (
			this.heroSpellsSelector.IsEnabled("legion_commander_press_the_attack") &&
			hero.Name === "npc_dota_hero_legion_commander" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const pta = hero.GetAbilityByName("legion_commander_press_the_attack")
			if (pta && pta.IsValid && pta.Level > 0 && pta.Cooldown <= 0.1 && hero.IsManaEnough(pta)) {
				const castRange = pta.CastRange > 0 ? pta.CastRange : 700
				for (const target of orderedAllies) {
					const needsDispel = target.IsStunned || target.IsHexed || target.IsRooted || target.IsSilenced
					if (
						needsDispel ||
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(pta, target), delay)
							return
						}
					}
				}
			}
		}

		// 1j. Omniknight Purification & Repel
		if (hero.Name === "npc_dota_hero_omniknight" && !hero.IsSilenced && !hero.IsStunned && !hero.IsHexed) {
			const puri = hero.GetAbilityByName("omniknight_purification")
			if (
				this.heroSpellsSelector.IsEnabled("omniknight_purification") &&
				puri &&
				puri.IsValid &&
				puri.Level > 0 &&
				puri.Cooldown <= 0.1 &&
				hero.IsManaEnough(puri)
			) {
				const castRange = puri.CastRange > 0 ? puri.CastRange : 600
				for (const target of orderedAllies) {
					if (target.HPPercent <= 40) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(puri, target), delay)
							return
						}
					}
				}
			}

			const repel = hero.GetAbilityByName("omniknight_repel")
			if (
				this.heroSpellsSelector.IsEnabled("omniknight_repel") &&
				repel &&
				repel.IsValid &&
				repel.Level > 0 &&
				repel.Cooldown <= 0.1 &&
				hero.IsManaEnough(repel)
			) {
				const castRange = repel.CastRange > 0 ? repel.CastRange : 600
				for (const target of orderedAllies) {
					if (target.HasBuffByName("modifier_omniknight_repel")) {
						continue
					}
					const needsDispel = target.IsStunned || target.IsHexed || target.IsRooted || target.IsSilenced
					if (
						needsDispel ||
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(repel, target), delay)
							return
						}
					}
				}
			}
		}

		// 1k. Vengeful Spirit Nether Swap
		if (
			this.heroSpellsSelector.IsEnabled("vengefulspirit_nether_swap") &&
			hero.Name === "npc_dota_hero_vengefulspirit" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const swap = hero.GetAbilityByName("vengefulspirit_nether_swap")
			if (swap && swap.IsValid && swap.Level > 0 && swap.Cooldown <= 0.1 && hero.IsManaEnough(swap)) {
				const castRange = swap.CastRange > 0 ? swap.CastRange : 700
				for (const target of orderedAllies) {
					if (target === hero) {
						continue
					}
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(swap, target), delay)
							return
						}
					}
				}
			}
		}

		// 1l. Pugna Decrepify
		if (
			this.heroSpellsSelector.IsEnabled("pugna_decrepify") &&
			hero.Name === "npc_dota_hero_pugna" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const decrepify = hero.GetAbilityByName("pugna_decrepify")
			if (
				decrepify &&
				decrepify.IsValid &&
				decrepify.Level > 0 &&
				decrepify.Cooldown <= 0.1 &&
				hero.IsManaEnough(decrepify)
			) {
				const castRange = decrepify.CastRange > 0 ? decrepify.CastRange : 700
				for (const target of orderedAllies) {
					if (
						!target.HasBuffByName("modifier_pugna_decrepify") &&
						!target.HasBuffByName("modifier_ghost") &&
						!this.isUnderOrTargetedByMagicThreat(target, allHeroes)
					) {
						if (
							this.shouldSaveTarget(
								target,
								allHeroes,
								hero,
								this.heroMinHP.value,
								this.heroOnlyDanger.value,
								this.heroLowHP.value,
								this.heroFatal.value
							)
						) {
							if (hero.Distance2D(target, true) <= castRange) {
								this.executeAndClaimOrder(() => hero.CastTarget(decrepify, target), delay)
								return
							}
						}
					}
				}
			}
		}

		// -------------------------------------------------------------
		// 2. LIFESAVING ITEMS (Lotus, Glimmer, Force, Solar, Greaves, WW, E-Blade, Linkens)
		// -------------------------------------------------------------

		// 2a. Lotus Orb (Dispel & Spell Reflection for Ally)
		if (this.itemsSelector.IsEnabled("item_lotus_orb") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const lotus = hero.GetItemByName("item_lotus_orb")
			if (lotus && lotus.CanBeUsable && lotus.Cooldown <= 0.1 && hero.IsManaEnough(lotus)) {
				const castRange = 900
				for (const target of orderedAllies) {
					if (target.HasBuffByName("modifier_item_lotus_orb_active")) {
						continue
					}
					let shouldLotus = false
					if (this.lotusDebuffs.value && LOTUS_DEBUFFS.some(m => target.HasBuffByName(m))) {
						shouldLotus = true
					}
					if (
						this.lotusSilence.value &&
						target.IsSilenced &&
						!target.HasBuffByName("modifier_doom_bringer_doom")
					) {
						shouldLotus = true
					}
					if (this.lotusRoot.value && target.IsRooted) {
						shouldLotus = true
					}
					if (!shouldLotus && this.isAboutToBeTargetedByReflectableThreat(target, allHeroes)) {
						shouldLotus = true
					}

					if (shouldLotus) {
						const inDanger =
							!this.lotusOnlyDanger.value || this.isTargetInDanger(target, 100, true, allHeroes, hero)
						if (inDanger && hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(lotus, target), delay)
							return
						}
					}
				}
			}
		}

		// 2b. Solar Crest / Pavise (Physical Barrier for Ally)
		if (
			(this.itemsSelector.IsEnabled("item_solar_crest") || this.itemsSelector.IsEnabled("item_pavise")) &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const crest = hero.GetItemByName("item_solar_crest")
			const pavise = hero.GetItemByName("item_pavise")
			const barrierItem =
				crest && crest.CanBeUsable && crest.Cooldown <= 0.1
					? crest
					: pavise && pavise.CanBeUsable && pavise.Cooldown <= 0.1
					? pavise
					: undefined

			if (barrierItem) {
				const castRange = 900
				for (const target of orderedAllies) {
					if (target.HPPercent <= 40 || this.hasFatalDebuff(target)) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(barrierItem, target), delay)
							return
						}
					}
				}
			}
		}

		// 2c. Glimmer Cape (Magic Barrier & Invisibility)
		if (this.itemsSelector.IsEnabled("item_glimmer_cape") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const glimmer = hero.GetItemByName("item_glimmer_cape")
			if (glimmer && glimmer.CanBeUsable && glimmer.Cooldown <= 0.1 && hero.IsManaEnough(glimmer)) {
				const castRange = 800
				for (const target of orderedAllies) {
					if (target.HasBuffByName("modifier_item_glimmer_cape")) {
						continue
					}
					if (
						this.isUnderOrTargetedByMagicThreat(target, allHeroes) ||
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(glimmer, target), delay)
							return
						}
					}
				}
			}
		}

		// 2d. Force Staff / Hurricane Pike (Push Ally away from Danger)
		if (this.itemsSelector.IsEnabled("item_force_staff") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const pike = hero.GetItemByName("item_hurricane_pike")
			const force = hero.GetItemByName("item_force_staff")
			const forceItem =
				pike && pike.CanBeUsable && pike.Cooldown <= 0.1
					? pike
					: force && force.CanBeUsable && force.Cooldown <= 0.1 && hero.IsManaEnough(force)
					? force
					: undefined

			if (forceItem) {
				const castRange = forceItem.Name === "item_hurricane_pike" ? 650 : 550
				for (const target of orderedAllies) {
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(forceItem, target), delay)
							return
						}
					}
				}
			}
		}

		// 2e. Guardian Greaves & Mekansm
		if (
			(this.itemsSelector.IsEnabled("item_guardian_greaves") || this.itemsSelector.IsEnabled("item_mekansm")) &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const greaves = hero.GetItemByName("item_guardian_greaves")
			const mek = hero.GetItemByName("item_mekansm")
			const healItem =
				greaves && greaves.CanBeUsable && greaves.Cooldown <= 0.1
					? greaves
					: mek && mek.CanBeUsable && mek.Cooldown <= 0.1 && hero.IsManaEnough(mek)
					? mek
					: undefined

			if (healItem) {
				let shouldHeal = false
				if (this.greavesAutoDispel.value && (hero.IsSilenced || hero.IsRooted)) {
					shouldHeal = true
				}
				if (!shouldHeal) {
					shouldHeal = orderedAllies.some(target => {
						if (hero.Distance2D(target, true) > 1200) {
							return false
						}
						return (
							this.mekGreavesLowHP.value &&
							this.isTargetInDanger(
								target,
								this.mekGreavesMinHP.value,
								this.mekGreavesOnlyDanger.value,
								allHeroes,
								hero
							)
						)
					})
				}
				if (shouldHeal) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(healItem), delay)
					return
				}
			}
		}

		// 2f. Holy Locket
		if (this.itemsSelector.IsEnabled("item_holy_locket") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const locket = hero.GetItemByName("item_holy_locket")
			if (locket && locket.CanBeUsable && locket.Cooldown <= 0.1 && (locket.CurrentCharges || 0) > 0) {
				const castRange = 500
				for (const target of orderedAllies) {
					if (target.HPPercent <= 30) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(locket, target), delay)
							return
						}
					}
				}
			}
		}

		// 2g. Wind Waker Ally Save
		if (
			this.itemsSelector.IsEnabled("item_wind_waker") &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const ww = hero.GetItemByName("item_wind_waker")
			if (ww && ww.CanBeUsable && ww.Cooldown <= 0.1 && hero.IsManaEnough(ww) && this.wwAllySave.value) {
				const castRange = 575
				for (const target of orderedAllies) {
					if (target === hero) {
						continue
					}
					if (target.HasBuffByName("modifier_eul_cyclone") || target.HasBuffByName("modifier_wind_waker")) {
						continue
					}
					if (
						this.shouldSaveTarget(
							target,
							allHeroes,
							hero,
							this.heroMinHP.value,
							this.heroOnlyDanger.value,
							this.heroLowHP.value,
							this.heroFatal.value
						)
					) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(ww, target), delay)
							return
						}
					}
				}
			}
		}

		// 2h. Linken's Sphere Active Transfer
		if (this.itemsSelector.IsEnabled("item_sphere") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const sphere = hero.GetItemByName("item_sphere")
			if (sphere && sphere.CanBeUsable && sphere.Cooldown <= 0.1) {
				const castRange = 700
				for (const target of orderedAllies) {
					if (target === hero || target.HasBuffByName("modifier_item_sphere_target")) {
						continue
					}
					if (this.isAboutToBeTargetedByThreat(target, allHeroes) || this.hasFatalDebuff(target)) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(sphere, target), delay)
							return
						}
					}
				}
			}
		}

		// 2i. Ethereal Blade Ally / Enemy Caster Save
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const eblade = hero.GetItemByName("item_ethereal_blade")
			if (eblade && eblade.CanBeUsable && eblade.Cooldown <= 0.1 && hero.IsManaEnough(eblade)) {
				const castRange = eblade.CastRange
				for (const target of orderedAllies) {
					if (
						target.HasBuffByName("modifier_item_ethereal_blade_ethereal") ||
						target.HasBuffByName("modifier_ghost") ||
						this.hasActiveSaveOrImmunity(target)
					) {
						continue
					}

					const isFatal =
						this.hasFatalDebuff(target) ||
						this.hasActiveThreatModifier(target) ||
						this.isAboutToBeTargetedByThreat(target, allHeroes)
					const isHPDanger =
						this.ebladeLowHP.value &&
						this.isTargetInDanger(
							target,
							this.ebladeMinHP.value,
							this.ebladeOnlyDanger.value,
							allHeroes,
							hero
						)

					if (isFatal && this.ebladeFatal.value) {
						if (this.ebladeDuelTarget.SelectedID === 0) {
							if (!this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
								if (hero.Distance2D(target, true) <= castRange) {
									this.executeAndClaimOrder(() => hero.CastTarget(eblade, target), delay)
									return
								}
							}
						} else {
							const caster = this.getEnemyCasterOfThreat(target, allHeroes)
							if (caster && !caster.IsMagicImmune && !caster.IsDebuffImmune) {
								if (hero.Distance2D(caster, true) <= castRange) {
									this.executeAndClaimOrder(() => hero.CastTarget(eblade, caster), delay)
									return
								}
							}
						}
					}

					if (isHPDanger && !this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
						if (hero.Distance2D(target, true) <= castRange) {
							this.executeAndClaimOrder(() => hero.CastTarget(eblade, target), delay)
							return
						}
					}
				}
			}
		}
	}

	private GameEnded(): void {
		this.castSleeper.ResetTimer()
		if (this.teamSelector) {
			this.teamSelector.values = []
			this.teamSelector.enabledValues.clear()
		}
	}
})()

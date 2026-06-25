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
	private readonly node = this.entry.AddNode("Auto Save")
	private readonly enabled = this.node.AddToggle("Enabled", true)

	private readonly priority = this.node.AddDropdown("Save Priority", ["Self First", "Team First"], 0)

	private readonly teamFilterNode = this.node.AddNode("Ally Target Filter", "menu/icons/dazzle.svg")
	private teamSelector?: Menu.ImageSelector

	// Hero Spells settings
	private readonly heroSpellsNode = this.node.AddNode("Hero Spells")
	private readonly heroSpellsSelector = this.heroSpellsNode.AddImageSelector(
		"Hero Spells Selection",
		[
			"dazzle_shallow_grave",
			"ringmaster_the_box",
			"shadow_demon_disruption",
			"vengefulspirit_nether_swap",
			"pugna_decrepify",
			"nyx_assassin_spiked_carapace",
			"oracle_false_promise"
		],
		new Map([
			["dazzle_shallow_grave", true],
			["ringmaster_the_box", true],
			["shadow_demon_disruption", true],
			["vengefulspirit_nether_swap", true],
			["pugna_decrepify", true],
			["nyx_assassin_spiked_carapace", true],
			["oracle_false_promise", true]
		]),
		"Enable or disable specific hero spells for saving",
		true
	)
	private readonly heroFatal = this.heroSpellsNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly heroLowHP = this.heroSpellsNode.AddToggle("Save on Low HP", true)
	private readonly heroOnlyDanger = this.heroSpellsNode.AddToggle("Only Save if in Danger", true)
	private readonly heroMinHP = this.heroSpellsNode.AddSlider("Save on HP %", 15, 1, 99)

	// Items settings
	private readonly itemsNode = this.node.AddNode("Items")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Items Selection",
		[
			"item_lotus_orb",
			"item_ethereal_blade",
			"item_mekansm",
			"item_guardian_greaves",
			"item_cyclone",
			"item_manta",
			"item_aeon_disk"
		],
		new Map([
			["item_lotus_orb", true],
			["item_ethereal_blade", true],
			["item_mekansm", true],
			["item_guardian_greaves", true],
			["item_cyclone", true],
			["item_manta", true],
			["item_aeon_disk", true]
		]),
		"Enable or disable specific items for saving",
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
	private readonly ebladeMinHP = this.ebladeNode.AddSlider("Save on HP %", 15, 1, 99)

	// Mekansm & Greaves settings
	private readonly mekGreavesNode = this.itemsNode.AddNode("Mekansm & Greaves")
	private readonly mekGreavesLowHP = this.mekGreavesNode.AddToggle("Save on Low HP", true)
	private readonly mekGreavesOnlyDanger = this.mekGreavesNode.AddToggle("Only Save if in Danger", true)
	private readonly mekGreavesMinHP = this.mekGreavesNode.AddSlider("Save on HP %", 25, 1, 99)
	private readonly greavesAutoDispel = this.mekGreavesNode.AddToggle("Auto-Dispel Self", true)

	// Eul / Wind Waker settings
	private readonly eulWwNode = this.itemsNode.AddNode("Eul / Wind Waker")
	private readonly eulSelfLowHP = this.eulWwNode.AddToggle("Save Self on Low HP", true)
	private readonly eulSelfOnlyDanger = this.eulWwNode.AddToggle("Only Save Self in Danger", true)
	private readonly eulSelfMinHP = this.eulWwNode.AddSlider("Save Self on HP %", 20, 1, 99)
	private readonly eulEnemyInterrupt = this.eulWwNode.AddToggle("Cyclone Enemy Caster", true)
	private readonly wwAllySave = this.eulWwNode.AddToggle("Wind Waker Save Allies", true)

	// Manta Style settings
	private readonly mantaNode = this.itemsNode.AddNode("Manta Style")
	private readonly mantaDispelSilence = this.mantaNode.AddToggle("Dispel Silence", true)
	private readonly mantaDispelRoot = this.mantaNode.AddToggle("Dispel Root", true)
	private readonly mantaDodgeProjectiles = this.mantaNode.AddToggle("Dodge Projectiles/Threats", true)
	private readonly mantaOnlyDanger = this.mantaNode.AddToggle("Only Save if in Danger", true)

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

		const isSelfFirst = this.priority.SelectedID === 0
		const self = allowed.find(a => a === hero)
		const team = allowed.filter(a => a !== hero)

		return isSelfFirst ? (self ? [self, ...team] : team) : self ? [...team, self] : team
	}

	private get hasLocalHero() {
		return LocalPlayer?.Hero !== undefined
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
			"modifier_nyx_assassin_spiked_carapace"
		]
		return saveModifiers.some(mod => unit.HasBuffByName(mod))
	}

	private isTargetInDanger(
		unit: Hero,
		minHP: number,
		onlySaveInDanger: boolean,
		allHeroes: Hero[],
		localHero: Hero
	): boolean {
		if (unit.HPPercent > minHP) {
			return false
		}
		if (!onlySaveInDanger) {
			return true
		}
		// If critically low HP (<= 5%), they might die to DoT (damage over time) even if no enemies are nearby
		if (unit.HPPercent <= 5) {
			return true
		}
		if (unit.IsStunned || unit.IsHexed || unit.IsNightmared || unit.IsSilenced) {
			return true
		}
		// AA Ice Blast or Witch Doctor Maledict
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

		// Detect ready instant-cast threats (hex, orchid, abyssal, etc.) without projectile/phase
		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				const items = enemy.HasInventory ? enemy.Items.filter((i): i is Item => i !== undefined) : []
				const abilities = [...spells, ...items]

				for (const abil of abilities) {
					if (INSTANT_REFLECTABLE_SPELLS.includes(abil.Name)) {
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

		const Lion = allHeroes.find(
			h => h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_lion" && !h.IsIllusion
		)
		if (target.HasBuffByName("modifier_lion_voodoo") && Lion) {
			return Lion
		}

		const Doom = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_doom_bringer" &&
				!h.IsIllusion
		)
		if (target.HasBuffByName("modifier_doom_bringer_doom") && Doom) {
			return Doom
		}

		const Pudge = allHeroes.find(
			h => h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_pudge" && !h.IsIllusion
		)
		if (target.HasBuffByName("modifier_pudge_dismember") && Pudge) {
			return Pudge
		}

		const PB = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_primal_beast" &&
				!h.IsIllusion
		)
		if (target.HasBuffByName("modifier_primal_beast_pulverize") && PB) {
			return PB
		}

		const Axe = allHeroes.find(
			h => h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_axe" && !h.IsIllusion
		)
		if (target.HasBuffByName("modifier_axe_berserkers_call") && Axe) {
			return Axe
		}

		const SB = allHeroes.find(
			h =>
				h &&
				h.IsValid &&
				h.IsAlive &&
				h.IsEnemy(target) &&
				h.Name === "npc_dota_hero_spirit_breaker" &&
				!h.IsIllusion
		)
		if (target.HasBuffByName("modifier_spirit_breaker_charge_of_darkness_vision") && SB) {
			return SB
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
							return enemy
						}
					}
				}
			}
		}

		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Source instanceof Hero && proj.Source.IsEnemy(target)) {
				return proj.Source
			}
		}

		let closestEnemy: Hero | undefined
		let minDist = Infinity
		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const dist = target.Distance2D(enemy, true)
				if (dist < minDist) {
					minDist = dist
					closestEnemy = enemy
				}
			}
		}
		return closestEnemy
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
			if (this.hasFatalDebuff(target) || this.hasActiveThreatModifier(target)) {
				return true
			}
			if (this.isAboutToBeTargetedByThreat(target, allHeroes)) {
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

		// Do not disrupt active channeling or break invisibility
		if (hero.IsChanneling || hero.IsInvisible) {
			return
		}

		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		const delay = GameState.InputLag * 1000 + Math.randomRange(50, 150)
		const orderedAllies = this.getOrderedAllies(hero, allHeroes)

		// 1. Dazzle Shallow Grave Logic
		if (
			this.heroSpellsSelector.IsEnabled("dazzle_shallow_grave") &&
			hero.Name === "npc_dota_hero_dazzle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const grave = hero.GetAbilityByName("dazzle_shallow_grave")
			if (grave && grave.IsValid && grave.Level > 0 && grave.Cooldown <= 0.1 && hero.IsManaEnough(grave)) {
				const castRange = grave.CastRange > 0 ? grave.CastRange : 600

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

		// 2. Ringmaster Escape Act Logic
		// Always prioritize self-save over allies, even in "Team First" mode
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

				// Step 1: Always check self first (can't save others if you're dead)
				if (
					this.shouldSaveTarget(
						hero,
						allHeroes,
						hero,
						this.heroMinHP.value,
						this.heroOnlyDanger.value,
						this.heroLowHP.value,
						this.heroFatal.value
					)
				) {
					this.executeAndClaimOrder(() => hero.CastTarget(box, hero), delay)
					return
				}

				// Step 2: Check allies
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
							this.executeAndClaimOrder(() => hero.CastTarget(box, target), delay)
							return
						}
					}
				}
			}
		}

		// 3. Shadow Demon Disruption Logic
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

		// 4. Vengeful Spirit Nether Swap Logic
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
					// Nether Swap cannot target self
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

		// 5. Pugna Decrepify Logic
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
					// Skip if already ethereal/ghost
					const isTargetEthereal = target.Buffs.some(
						b =>
							b.Name === "modifier_item_ethereal_blade_ethereal" ||
							b.Name === "modifier_ghost" ||
							b.Name === "modifier_pugna_decrepify"
					)
					if (isTargetEthereal) {
						continue
					}

					// Prevent Decrepify on ally if under or targeted by magic threat
					if (this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
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
							this.executeAndClaimOrder(() => hero.CastTarget(decrepify, target), delay)
							return
						}
					}
				}
			}
		}

		// 6. Nyx Assassin Spiked Carapace Logic
		if (
			this.heroSpellsSelector.IsEnabled("nyx_assassin_spiked_carapace") &&
			hero.Name === "npc_dota_hero_nyx_assassin" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const carapace = hero.GetAbilityByName("nyx_assassin_spiked_carapace")
			if (
				carapace &&
				carapace.IsValid &&
				carapace.Level > 0 &&
				carapace.Cooldown <= 0.1 &&
				hero.IsManaEnough(carapace)
			) {
				if (
					!hero.HasBuffByName("modifier_nyx_assassin_spiked_carapace") &&
					this.shouldSaveTarget(
						hero,
						allHeroes,
						hero,
						this.heroMinHP.value,
						this.heroOnlyDanger.value,
						this.heroLowHP.value,
						this.heroFatal.value
					)
				) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(carapace), delay)
					return
				}
			}
		}

		// 7. Oracle False Promise Logic
		if (
			this.heroSpellsSelector.IsEnabled("oracle_false_promise") &&
			hero.Name === "npc_dota_hero_oracle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const fate = hero.GetAbilityByName("oracle_false_promise")
			if (fate && fate.IsValid && fate.Level > 0 && fate.Cooldown <= 0.1 && hero.IsManaEnough(fate)) {
				const castRange = fate.CastRange > 0 ? fate.CastRange : 700

				for (const target of orderedAllies) {
					// Skip if target already has False Promise
					if (target.HasBuffByName("modifier_oracle_false_promise")) {
						continue
					}

					// Don't cast on self if we have a better save item (e.g., Aeon Disk active)
					if (target === hero && this.hasActiveSaveOrImmunity(hero)) {
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
							this.executeAndClaimOrder(() => hero.CastTarget(fate, target), delay)
							return
						}
					}
				}
			}
		}

		// 8. Ethereal Blade Logic
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const eblade = hero.GetItemByName("item_ethereal_blade")
			if (eblade && eblade.CanBeUsable && eblade.Cooldown <= 0.1 && hero.IsManaEnough(eblade)) {
				const castRange = eblade.CastRange

				for (const target of orderedAllies) {
					// Check if target is already ethereal/ghosted
					const isTargetEthereal = target.Buffs.some(
						b =>
							b.Name === "modifier_item_ethereal_blade_ethereal" ||
							b.Name === "modifier_ghost" ||
							b.Name === "modifier_pugna_decrepify"
					)
					if (isTargetEthereal) {
						continue
					}

					// Skip target if they already have active save or banish/immunity
					if (this.hasActiveSaveOrImmunity(target)) {
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

					// Handle Fatal Debuffs save logic
					if (isFatal && this.ebladeFatal.value) {
						if (this.ebladeDuelTarget.SelectedID === 0) {
							// Target Affected Ally
							// Prevent EBlade on ally if under or targeted by magic threat
							if (!this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
								if (hero.Distance2D(target, true) <= castRange) {
									hero.CastTarget(eblade, target)
									this.castSleeper.Sleep(delay)
									return
								}
							}
						} else {
							// Target enemy Caster
							const caster = this.getEnemyCasterOfThreat(target, allHeroes)
							if (caster && !caster.IsMagicImmune && !caster.IsDebuffImmune) {
								const isCasterEthereal = caster.Buffs.some(
									b =>
										b.Name === "modifier_item_ethereal_blade_ethereal" ||
										b.Name === "modifier_ghost" ||
										b.Name === "modifier_pugna_decrepify"
								)
								if (!isCasterEthereal && hero.Distance2D(caster, true) <= castRange) {
									this.executeAndClaimOrder(() => hero.CastTarget(eblade, caster), delay)
									return
								}
							}
						}
					}

					// Handle low HP save logic
					if (isHPDanger) {
						// Prevent EBlade on ally if under or targeted by magic threat
						if (!this.isUnderOrTargetedByMagicThreat(target, allHeroes)) {
							if (hero.Distance2D(target, true) <= castRange) {
								this.executeAndClaimOrder(() => hero.CastTarget(eblade, target), delay)
								return
							}
						}
					}
				}
			}
		}

		// 9. Lotus Orb Logic
		if (this.itemsSelector.IsEnabled("item_lotus_orb") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const lotus = hero.GetItemByName("item_lotus_orb")
			if (lotus && lotus.CanBeUsable && lotus.Cooldown <= 0.1 && hero.IsManaEnough(lotus)) {
				const castRange = 900

				for (const target of orderedAllies) {
					if (target.HasBuffByName("modifier_item_lotus_orb_active")) {
						continue
					}

					let shouldLotus = false

					if (this.lotusDebuffs.value) {
						const hasTrackOrHaze = LOTUS_DEBUFFS.some(mod => {
							if (mod === "modifier_spirit_breaker_charge_of_darkness_vision") {
								if (!target.HasBuffByName(mod)) {
									return false
								}
								const sb = allHeroes.find(
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
						if (hasTrackOrHaze) {
							shouldLotus = true
						}
					}

					if (this.lotusSilence.value && target.IsSilenced) {
						if (!target.HasBuffByName("modifier_doom_bringer_doom")) {
							shouldLotus = true
						}
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
						if (inDanger) {
							if (hero.Distance2D(target, true) <= castRange) {
								this.executeAndClaimOrder(() => hero.CastTarget(lotus, target), delay)
								return
							}
						}
					}
				}
			}
		}

		// 10. Mekansm Logic
		if (this.itemsSelector.IsEnabled("item_mekansm") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const mek = hero.GetItemByName("item_mekansm")
			if (mek && mek.CanBeUsable && mek.Cooldown <= 0.1 && hero.IsManaEnough(mek)) {
				const hasAllyInDanger = orderedAllies.some(target => {
					if (hero.Distance2D(target, true) > 1200) {
						return false
					}
					if (target.HasBuffByName("modifier_item_mekansm_no_heal")) {
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

				if (hasAllyInDanger) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(mek), delay)
					return
				}
			}
		}

		// 11. Guardian Greaves Logic
		if (
			this.itemsSelector.IsEnabled("item_guardian_greaves") &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const greaves = hero.GetItemByName("item_guardian_greaves")
			if (greaves && greaves.CanBeUsable && greaves.Cooldown <= 0.1) {
				// 1. Check if we need to auto-dispel self
				let shouldCastGreaves = false
				if (this.greavesAutoDispel.value && (hero.IsSilenced || hero.IsRooted)) {
					shouldCastGreaves = true
				}

				// 2. Check if any ally within radius needs healing
				if (!shouldCastGreaves) {
					shouldCastGreaves = orderedAllies.some(target => {
						if (hero.Distance2D(target, true) > 1200) {
							return false
						}
						if (target.HasBuffByName("modifier_item_mekansm_no_heal")) {
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

				if (shouldCastGreaves) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(greaves), delay)
					return
				}
			}
		}

		// 12. Eul's / Wind Waker Logic
		if (this.itemsSelector.IsEnabled("item_cyclone") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const ww = hero.GetItemByName("item_wind_waker")
			const eul = hero.GetItemByName("item_cyclone")
			const cycloneItem =
				ww && ww.CanBeUsable && ww.Cooldown <= 0.1 && hero.IsManaEnough(ww)
					? ww
					: eul && eul.CanBeUsable && eul.Cooldown <= 0.1 && hero.IsManaEnough(eul)
					? eul
					: undefined

			if (cycloneItem) {
				const isWindWaker = cycloneItem.Name === "item_wind_waker"
				const castRange = 575

				// 1. Self Save
				if (this.eulSelfLowHP.value && !hero.IsSilenced) {
					const selfInDanger = this.isTargetInDanger(
						hero,
						this.eulSelfMinHP.value,
						this.eulSelfOnlyDanger.value,
						allHeroes,
						hero
					)
					const isSelfCycloned = hero.HasBuffByName("modifier_euler_cyclone")
					if (selfInDanger && !isSelfCycloned && !this.hasActiveSaveOrImmunity(hero)) {
						this.executeAndClaimOrder(() => hero.CastTarget(cycloneItem, hero), delay)
						return
					}
				}

				// 2. Enemy Caster Interrupt (Channeling/Fatal spells)
				if (this.eulEnemyInterrupt.value && !hero.IsSilenced) {
					for (const target of orderedAllies) {
						const isFatal =
							this.hasFatalDebuff(target) ||
							this.hasActiveThreatModifier(target) ||
							this.isAboutToBeTargetedByThreat(target, allHeroes)
						if (isFatal) {
							const enemyCaster = this.getEnemyCasterOfThreat(target, allHeroes)
							if (
								enemyCaster &&
								enemyCaster.IsValid &&
								enemyCaster.IsAlive &&
								!enemyCaster.IsMagicImmune &&
								!enemyCaster.IsDebuffImmune &&
								!enemyCaster.HasBuffByName("modifier_euler_cyclone")
							) {
								if (hero.Distance2D(enemyCaster, true) <= castRange) {
									this.executeAndClaimOrder(() => hero.CastTarget(cycloneItem, enemyCaster), delay)
									return
								}
							}
						}
					}
				}

				// 3. Wind Waker Ally Save (Only if Wind Waker, can target allies)
				if (isWindWaker && this.wwAllySave.value && !hero.IsSilenced) {
					for (const target of orderedAllies) {
						if (target === hero) {
							continue
						}

						if (target.HasBuffByName("modifier_euler_cyclone") || this.hasActiveSaveOrImmunity(target)) {
							continue
						}

						const isFatal =
							this.hasFatalDebuff(target) ||
							this.hasActiveThreatModifier(target) ||
							this.isAboutToBeTargetedByThreat(target, allHeroes)
						const isHPDanger = this.isTargetInDanger(
							target,
							this.eulSelfMinHP.value,
							this.eulSelfOnlyDanger.value,
							allHeroes,
							hero
						)

						if (isFatal || isHPDanger) {
							if (hero.Distance2D(target, true) <= castRange) {
								this.executeAndClaimOrder(() => hero.CastTarget(cycloneItem, target), delay)
								return
							}
						}
					}
				}
			}
		}

		// 13. Manta Style Logic
		if (this.itemsSelector.IsEnabled("item_manta") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const manta = hero.GetItemByName("item_manta")
			if (manta && manta.CanBeUsable && manta.Cooldown <= 0.1 && hero.IsManaEnough(manta)) {
				let shouldCastManta = false

				// 1. Dispel Silence / Root
				if (this.mantaDispelSilence.value && hero.IsSilenced) {
					shouldCastManta = true
				}
				if (this.mantaDispelRoot.value && hero.IsRooted) {
					shouldCastManta = true
				}

				// 2. Dodge Projectiles or incoming threats targeted at us
				if (!shouldCastManta && this.mantaDodgeProjectiles.value) {
					if (
						this.isAboutToBeTargetedByReflectableThreat(hero, allHeroes) ||
						this.isUnderOrTargetedByMagicThreat(hero, allHeroes)
					) {
						shouldCastManta = true
					}
				}

				// 3. Dispel fatal debuffs / active threats (stun, hex, silence, track, etc.)
				if (!shouldCastManta) {
					if (this.hasFatalDebuff(hero) || this.hasActiveThreatModifier(hero)) {
						shouldCastManta = true
					}
				}

				if (shouldCastManta) {
					const inDanger =
						!this.mantaOnlyDanger.value || this.isTargetInDanger(hero, 100, true, allHeroes, hero)
					if (inDanger) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(manta), delay)
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

import {
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"

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

new (class AutoSaveUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("Auto Save")
	private readonly enabled = this.node.AddToggle("Enabled", true)

	// Dazzle settings
	private readonly dazzleNode = this.node.AddNode("Dazzle Shallow Grave")
	private readonly dazzleEnabled = this.dazzleNode.AddToggle("Enable Shallow Grave", true)
	private readonly dazzleFatal = this.dazzleNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly dazzleLowHP = this.dazzleNode.AddToggle("Save on Low HP", true)
	private readonly dazzleOnlyDanger = this.dazzleNode.AddToggle("Only Save if in Danger", true)
	private readonly dazzleMinHP = this.dazzleNode.AddSlider("Save on HP %", 15, 1, 99)

	// Ringmaster settings
	private readonly ringmasterNode = this.node.AddNode("Ringmaster Escape Act")
	private readonly ringmasterEnabled = this.ringmasterNode.AddToggle("Enable Escape Act", true)
	private readonly ringmasterFatal = this.ringmasterNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly ringmasterLowHP = this.ringmasterNode.AddToggle("Save on Low HP", true)
	private readonly ringmasterOnlyDanger = this.ringmasterNode.AddToggle("Only Save if in Danger", true)
	private readonly ringmasterMinHP = this.ringmasterNode.AddSlider("Save on HP %", 15, 1, 99)

	// Shadow Demon settings
	private readonly sdNode = this.node.AddNode("Shadow Demon Disruption")
	private readonly sdEnabled = this.sdNode.AddToggle("Enable Disruption", true)
	private readonly sdFatal = this.sdNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly sdLowHP = this.sdNode.AddToggle("Save on Low HP", true)
	private readonly sdOnlyDanger = this.sdNode.AddToggle("Only Save if in Danger", true)
	private readonly sdMinHP = this.sdNode.AddSlider("Save on HP %", 15, 1, 99)

	// Vengeful Spirit settings
	private readonly vengeNode = this.node.AddNode("Vengeful Spirit Nether Swap")
	private readonly vengeEnabled = this.vengeNode.AddToggle("Enable Nether Swap", true)
	private readonly vengeFatal = this.vengeNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly vengeLowHP = this.vengeNode.AddToggle("Save on Low HP", true)
	private readonly vengeOnlyDanger = this.vengeNode.AddToggle("Only Save if in Danger", true)
	private readonly vengeMinHP = this.vengeNode.AddSlider("Save on HP %", 15, 1, 99)

	// Pugna settings
	private readonly pugnaNode = this.node.AddNode("Pugna Decrepify")
	private readonly pugnaEnabled = this.pugnaNode.AddToggle("Enable Decrepify", true)
	private readonly pugnaFatal = this.pugnaNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly pugnaLowHP = this.pugnaNode.AddToggle("Save on Low HP", true)
	private readonly pugnaOnlyDanger = this.pugnaNode.AddToggle("Only Save if in Danger", true)
	private readonly pugnaMinHP = this.pugnaNode.AddSlider("Save on HP %", 15, 1, 99)

	// Ethereal Blade settings
	private readonly ebladeNode = this.node.AddNode("Ethereal Blade")
	private readonly ebladeEnabled = this.ebladeNode.AddToggle("Enable Ethereal Blade", true)
	private readonly ebladeFatal = this.ebladeNode.AddToggle("Save on Fatal Debuffs", true)
	private readonly ebladeDuelTarget = this.ebladeNode.AddDropdown(
		"Fatal Debuff Target",
		["Affected Ally", "Enemy Caster"],
		0
	)
	private readonly ebladeLowHP = this.ebladeNode.AddToggle("Save on Low HP", true)
	private readonly ebladeOnlyDanger = this.ebladeNode.AddToggle("Only Save if in Danger", true)
	private readonly ebladeMinHP = this.ebladeNode.AddSlider("Save on HP %", 15, 1, 99)

	private readonly castSleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
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
			"modifier_obsidian_destroyer_astral_imprisonment"
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
				h.IsEnemy(localHero) &&
				!h.IsIllusion &&
				(unit.Distance2D(h, true) <= 1000 ||
					(h.IsAttacking && h.Distance2D(unit, true) <= h.GetAttackRange(unit) + 200))
		)
		return enemyNearby
	}

	private getEnemyCasterOfFatalDebuff(target: Hero, allHeroes: Hero[]): Hero | undefined {
		if (target.HasBuffByName("modifier_legion_commander_duel")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_legion_commander" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_necrolyte_reapers_scythe")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_necrolyte" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_bane_fiends_grip")) {
			return allHeroes.find(
				h =>
					h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_bane" && !h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_batrider_flaming_lasso")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_batrider" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_shadow_shaman_shackles")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_shadow_shaman" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_axe_berserkers_call")) {
			return allHeroes.find(
				h => h && h.IsValid && h.IsAlive && h.IsEnemy(target) && h.Name === "npc_dota_hero_axe" && !h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_doom_bringer_doom")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_doom_bringer" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_pudge_dismember")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_pudge" &&
					!h.IsIllusion
			)
		}
		if (target.HasBuffByName("modifier_primal_beast_pulverize")) {
			return allHeroes.find(
				h =>
					h &&
					h.IsValid &&
					h.IsAlive &&
					h.IsEnemy(target) &&
					h.Name === "npc_dota_hero_primal_beast" &&
					!h.IsIllusion
			)
		}
		return undefined
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

		// 1. Dazzle Shallow Grave Logic
		if (
			this.dazzleEnabled.value &&
			hero.Name === "npc_dota_hero_dazzle" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const grave = hero.GetAbilityByName("dazzle_shallow_grave")
			if (grave && grave.IsValid && grave.Level > 0 && grave.Cooldown <= 0.1 && hero.IsManaEnough(grave)) {
				const castRange = grave.CastRange > 0 ? grave.CastRange : 600

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

					// Skip target if they already have active save or death immunity
					if (this.hasActiveSaveOrImmunity(target)) {
						continue
					}

					const isFatal = this.hasFatalDebuff(target)
					const isHPDanger =
						this.dazzleLowHP.value &&
						this.isTargetInDanger(
							target,
							this.dazzleMinHP.value,
							this.dazzleOnlyDanger.value,
							allHeroes,
							hero
						)

					if ((isFatal && this.dazzleFatal.value) || isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(grave, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}

		// 2. Ringmaster Escape Act Logic
		if (
			this.ringmasterEnabled.value &&
			hero.Name === "npc_dota_hero_ringmaster" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const box = hero.GetAbilityByName("ringmaster_the_box")
			if (box && box.IsValid && box.Level > 0 && box.Cooldown <= 0.1 && hero.IsManaEnough(box)) {
				const castRange = box.CastRange > 0 ? box.CastRange : 600

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

					// Skip target if they already have active save or banish/immunity
					if (this.hasActiveSaveOrImmunity(target)) {
						continue
					}

					const isFatal = this.hasFatalDebuff(target)
					const isHPDanger =
						this.ringmasterLowHP.value &&
						this.isTargetInDanger(
							target,
							this.ringmasterMinHP.value,
							this.ringmasterOnlyDanger.value,
							allHeroes,
							hero
						)

					if ((isFatal && this.ringmasterFatal.value) || isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(box, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}

		// 3. Shadow Demon Disruption Logic
		if (
			this.sdEnabled.value &&
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

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

					// Skip target if they already have active save or banish/immunity
					if (this.hasActiveSaveOrImmunity(target)) {
						continue
					}

					const isFatal = this.hasFatalDebuff(target)
					const isHPDanger =
						this.sdLowHP.value &&
						this.isTargetInDanger(target, this.sdMinHP.value, this.sdOnlyDanger.value, allHeroes, hero)

					if ((isFatal && this.sdFatal.value) || isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(disruption, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}

		// 4. Vengeful Spirit Nether Swap Logic
		if (
			this.vengeEnabled.value &&
			hero.Name === "npc_dota_hero_vengefulspirit" &&
			!hero.IsSilenced &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const swap = hero.GetAbilityByName("vengefulspirit_nether_swap")
			if (swap && swap.IsValid && swap.Level > 0 && swap.Cooldown <= 0.1 && hero.IsManaEnough(swap)) {
				const castRange = swap.CastRange > 0 ? swap.CastRange : 700

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

					// Nether Swap cannot target self
					if (target === hero) {
						continue
					}

					// Skip target if they already have active save or banish/immunity
					if (this.hasActiveSaveOrImmunity(target)) {
						continue
					}

					const isFatal = this.hasFatalDebuff(target)
					const isHPDanger =
						this.vengeLowHP.value &&
						this.isTargetInDanger(
							target,
							this.vengeMinHP.value,
							this.vengeOnlyDanger.value,
							allHeroes,
							hero
						)

					if ((isFatal && this.vengeFatal.value) || isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(swap, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}

		// 5. Pugna Decrepify Logic
		if (
			this.pugnaEnabled.value &&
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

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

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

					// Skip Decrepify on ally if under Reaper's Scythe or Doom (to avoid amplifying magic damage / being useless)
					if (
						target.HasBuffByName("modifier_necrolyte_reapers_scythe") ||
						target.HasBuffByName("modifier_doom_bringer_doom")
					) {
						continue
					}

					// Skip target if they already have active save or banish/immunity
					if (this.hasActiveSaveOrImmunity(target)) {
						continue
					}

					const isFatal = this.hasFatalDebuff(target)
					const isHPDanger =
						this.pugnaLowHP.value &&
						this.isTargetInDanger(
							target,
							this.pugnaMinHP.value,
							this.pugnaOnlyDanger.value,
							allHeroes,
							hero
						)

					if ((isFatal && this.pugnaFatal.value) || isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(decrepify, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}

		// 6. Ethereal Blade Logic
		if (this.ebladeEnabled.value && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const eblade = hero.GetItemByName("item_ethereal_blade")
			if (eblade && eblade.CanBeUsable && eblade.Cooldown <= 0.1 && hero.IsManaEnough(eblade)) {
				const castRange = eblade.CastRange

				for (const target of allHeroes) {
					if (!target || !target.IsValid || !target.IsAlive || target.IsIllusion || target.IsEnemy(hero)) {
						continue
					}

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

					const isFatal = this.hasFatalDebuff(target)
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
							// Skip Ethereal Blade on ally if it's Reaper's Scythe or Doom (to avoid increasing magic damage / being useless)
							const hasMagicFatal =
								target.HasBuffByName("modifier_necrolyte_reapers_scythe") ||
								target.HasBuffByName("modifier_doom_bringer_doom")
							if (!hasMagicFatal) {
								if (hero.Distance2D(target, true) <= castRange) {
									hero.CastTarget(eblade, target)
									this.castSleeper.Sleep(delay)
									return
								}
							}
						} else {
							// Target enemy Caster
							const caster = this.getEnemyCasterOfFatalDebuff(target, allHeroes)
							if (caster && !caster.IsMagicImmune && !caster.IsDebuffImmune) {
								const isCasterEthereal = caster.Buffs.some(
									b =>
										b.Name === "modifier_item_ethereal_blade_ethereal" ||
										b.Name === "modifier_ghost" ||
										b.Name === "modifier_pugna_decrepify"
								)
								if (!isCasterEthereal && hero.Distance2D(caster, true) <= castRange) {
									hero.CastTarget(eblade, caster)
									this.castSleeper.Sleep(delay)
									return
								}
							}
						}
					}

					// Handle low HP save logic
					if (isHPDanger) {
						if (hero.Distance2D(target, true) <= castRange) {
							hero.CastTarget(eblade, target)
							this.castSleeper.Sleep(delay)
							return
						}
					}
				}
			}
		}
	}

	private GameEnded(): void {
		this.castSleeper.ResetTimer()
	}
})()

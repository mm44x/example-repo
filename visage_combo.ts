import {
	Ability,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	InputManager,
	LocalPlayer,
	Menu,
	npc_dota_visage_familiar,
	TickSleeper,
	Unit
} from "github.com/octarine-public/wrapper/index"
import { executeOrbwalk } from "./orbwalker"

new (class VisageCombo {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Visage Combo")

	// Enable/Disable combo
	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Visage combo script")

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Visage combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Follow moving targets by cancelling attack backswing"
	)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider(
		"Orb Walk Safe Distance %",
		80,
		10,
		100,
		5,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break on some heroes"
	)
	private readonly minSoulCharges = this.entry.AddSlider(
		"Min Soul Assumption Charges",
		3,
		1,
		6,
		0,
		"Minimum stacks before casting Soul Assumption"
	)
	private readonly autoStoneFormEnabled = this.entry.AddToggle(
		"Auto Stone Form (Stun Chain)",
		true,
		"Chain-stun target with familiars"
	)

	// Auto Soul Assumption node
	private readonly autoSoulNode = this.entry.AddNode("Auto Soul Assumption")
	private readonly autoSoulEnabled = this.autoSoulNode.AddToggle(
		"Enabled",
		false,
		"Auto cast Soul Assumption outside combo key"
	)
	private readonly autoSoulMinCharges = this.autoSoulNode.AddSlider(
		"Min Charges",
		4,
		1,
		6,
		0,
		"Minimum stacks to auto-cast"
	)

	// Auto Save node
	private readonly autoSaveNode = this.entry.AddNode("Auto Save (Low HP)")
	private readonly autoSaveEnabled = this.autoSaveNode.AddToggle(
		"Enabled",
		true,
		"Auto save Visage and familiars when low HP"
	)
	private readonly visageSaveHpPct = this.autoSaveNode.AddSlider(
		"Visage Save HP %",
		30,
		5,
		80,
		0,
		"HP percentage to trigger Visage self-save"
	)
	private readonly familiarSaveHpPct = this.autoSaveNode.AddSlider(
		"Familiar Save HP %",
		40,
		5,
		80,
		0,
		"HP percentage to trigger Familiar Stone Form save"
	)
	private readonly visageSaveGraveChill = this.autoSaveNode.AddToggle(
		"Visage: Use Grave Chill",
		true,
		"Cast Grave Chill on nearest enemy to slow"
	)
	private readonly visageSaveSilentGrave = this.autoSaveNode.AddToggle(
		"Visage: Use Silent As The Grave",
		true,
		"Cast Silent As The Grave for invis"
	)
	private readonly visageSaveGravekeepersCloak = this.autoSaveNode.AddToggle(
		"Visage: Use Gravekeeper's Cloak",
		true,
		"Cast Gravekeeper's Cloak (Aghs Shard) for stone form"
	)
	private readonly familiarSaveStoneForm = this.autoSaveNode.AddToggle(
		"Familiar: Use Stone Form",
		true,
		"Cast Stone Form for magic immunity + stun aura"
	)

	private comboSequenceGrid: any

	private readonly sleeper = new TickSleeper()
	private readonly familiarSleeper = new TickSleeper()
	private readonly summonSleeper = new TickSleeper()
	private readonly autoSoulSleeper = new TickSleeper()
	private readonly autoSaveSleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("visage_grave_chill", [true, true, true, 0])
		defaultCombo.set("visage_soul_assumption", [true, true, true, 1])
		defaultCombo.set("visage_silent_as_the_grave", [true, true, true, 2])
		defaultCombo.set("visage_summon_familiars", [true, true, true, 3])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			["visage_grave_chill", "visage_soul_assumption", "visage_silent_as_the_grave", "visage_summon_familiars"],
			defaultCombo
		)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.familiarSleeper.Sleep(0)
		this.summonSleeper.Sleep(0)
		this.autoSoulSleeper.Sleep(0)
		this.autoSaveSleeper.Sleep(0)
		this.comboSequenceGrid = null
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_visage"
		)
	}

	/**
	 * Mendapatkan semua familiar yang masih hidup dan bisa dikontrol oleh pemain lokal.
	 */
	private getControllableFamiliars(): npc_dota_visage_familiar[] {
		const familiars: npc_dota_visage_familiar[] = []
		for (const unit of EntityManager.GetEntitiesByClass(npc_dota_visage_familiar)) {
			if (unit.IsValid && unit.IsAlive && unit.IsControllable) {
				familiars.push(unit)
			}
		}
		return familiars
	}

	/**
	 * Menghitung sisa durasi stun pada target.
	 * Mengecek semua buff/debuff dan mencari modifier yang terkait stun
	 * lalu mengembalikan RemainingTime tertinggi.
	 */
	private getTargetStunRemainingTime(target: Unit): number {
		if (!target.IsStunned) {
			return 0
		}
		let maxRemaining = 0
		for (const buff of target.Buffs) {
			// Cari semua modifier yang mengandung kata "stun" atau "stone_form"
			const name = buff.Name.toLowerCase()
			if (
				name.includes("stun") ||
				name.includes("stone_form") ||
				name.includes("bash") ||
				name.includes("hex") ||
				name.includes("telekinesis")
			) {
				if (buff.RemainingTime > maxRemaining) {
					maxRemaining = buff.RemainingTime
				}
			}
		}
		// Fallback: jika target stunned tapi tidak ditemukan modifier khusus, return estimasi kecil
		if (maxRemaining === 0 && target.IsStunned) {
			maxRemaining = 0.1
		}
		return maxRemaining
	}

	/**
	 * Eksekusi sequential chain-stun Stone Form pada familiars.
	 * Hanya 1 familiar drop stone form per tick.
	 * Familiar terdekat target yang punya Stone Form ready akan digunakan.
	 */
	private executeStoneFormChainStun(familiars: npc_dota_visage_familiar[], target: Hero): boolean {
		if (this.familiarSleeper.Sleeping) {
			return false
		}

		const stunRemaining = this.getTargetStunRemainingTime(target)
		// Smart threshold: Stone Form fall delay (~0.55s) + network latency
		const stoneFormFallDelay = 0.55
		const thresholdSec = stoneFormFallDelay + GameState.InputLag

		// Jika target masih dalam durasi stun yang cukup lama, tunggu dulu
		if (stunRemaining > thresholdSec) {
			return false
		}

		// Cari familiar terdekat ke target yang punya Stone Form ready
		let bestFamiliar: npc_dota_visage_familiar | undefined
		let bestStoneForm: Ability | undefined
		let bestDist = Infinity

		for (const familiar of familiars) {
			const stoneForm = familiar.GetAbilityByName("visage_summon_familiars_stone_form")
			if (stoneForm && stoneForm.IsValid && stoneForm.Level > 0 && stoneForm.Cooldown <= 0.1) {
				const dist = familiar.Distance2D(target)
				if (dist < bestDist) {
					bestDist = dist
					bestFamiliar = familiar
					bestStoneForm = stoneForm
				}
			}
		}

		if (!bestFamiliar || !bestStoneForm) {
			return false
		}

		// Stone Form memiliki radius AoE, pastikan familiar cukup dekat
		// Stone Form stun radius biasanya ~325
		const stoneFormRadius = 375
		if (bestDist > stoneFormRadius) {
			return false
		}

		// Cast Stone Form (no target ability pada familiar)
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
			issuers: [bestFamiliar],
			ability: bestStoneForm.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})

		// Delay cukup lama agar stone form landing sebelum familiar berikutnya drop
		// Stone Form memiliki delay sekitar 0.55 detik sebelum stun
		this.familiarSleeper.Sleep(GameState.InputLag * 1000 + 600)
		return true
	}

	/**
	 * Perintahkan semua familiar yang tidak sedang Stone Form untuk menyerang target.
	 */
	private orderFamiliarsAttack(familiars: npc_dota_visage_familiar[], target: Hero): void {
		for (const familiar of familiars) {
			// Jangan perintahkan attack jika familiar sedang casting Stone Form
			if (familiar.IsChanneling) {
				continue
			}

			// Jika familiar sudah memiliki modifier stone form buff (sedang dalam animasi stone),
			// skip attack order
			const hasStoneFormBuff = familiar.Buffs.some(
				b => b.Name === "modifier_visage_summon_familiars_stone_form_buff"
			)
			if (hasStoneFormBuff) {
				continue
			}

			// Cek apakah familiar sudah menyerang target yang sama
			const currentTarget = familiar.Target
			if (currentTarget && currentTarget.Index === target.Index) {
				continue
			}

			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
				issuers: [familiar],
				target: target.Index,
				queue: false,
				showEffects: false,
				isPlayerInput: false
			})
		}
	}

	/**
	 * Mendapatkan jumlah Soul Assumption charges saat ini dari modifier hero.
	 */
	private getSoulAssumptionCharges(hero: Hero): number {
		for (const buff of hero.Buffs) {
			if (buff.Name === "modifier_visage_soul_assumption") {
				return buff.StackCount
			}
		}
		return 0
	}

	/**
	 * Auto Soul Assumption — berjalan secara independen tanpa combo key.
	 * Trigger berdasarkan musuh terdekat dalam jarak cast range skill.
	 */
	private executeAutoSoulAssumption(hero: Hero): void {
		if (
			!this.autoSoulEnabled.value ||
			this.autoSoulSleeper.Sleeping ||
			hero.IsChanneling ||
			hero.IsStunned ||
			hero.IsSilenced ||
			hero.IsHexed
		) {
			return
		}

		const soulAssumption = hero.GetAbilityByName("visage_soul_assumption")
		if (
			!soulAssumption ||
			!soulAssumption.IsValid ||
			soulAssumption.Level <= 0 ||
			soulAssumption.Cooldown > 0.1 ||
			hero.Mana < soulAssumption.ManaCost ||
			this.getSoulAssumptionCharges(hero) < this.autoSoulMinCharges.value
		) {
			return
		}

		const castRange = soulAssumption.CastRange > 0 ? soulAssumption.CastRange : 900
		const bestTarget = EntityManager.GetEntitiesByClass(Hero).find(
			e =>
				e.IsValid &&
				e.IsAlive &&
				e.IsVisible &&
				e.IsEnemy(hero) &&
				!e.IsIllusion &&
				!e.IsMagicImmune &&
				!e.IsDebuffImmune &&
				hero.Distance2D(e) <= castRange
		)

		if (!bestTarget) {
			return
		}

		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
			issuers: [hero],
			target: bestTarget.Index,
			ability: soulAssumption.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
		this.autoSoulSleeper.Sleep(GameState.InputLag * 1000 + soulAssumption.CastPoint * 1000 + 100)
	}

	/**
	 * Auto Save — triggers when Visage or familiars are low HP.
	 * Runs independently of combo key.
	 */
	private executeAutoSave(hero: Hero): void {
		if (!this.autoSaveEnabled.value) {
			return
		}
		if (this.autoSaveSleeper.Sleeping) {
			return
		}

		// --- Visage Self Save ---
		const visageHpPct = (hero.HP / hero.MaxHP) * 100
		if (visageHpPct <= this.visageSaveHpPct.value) {
			if (
				this.visageSaveGraveChill.value &&
				!hero.IsChanneling &&
				!hero.IsStunned &&
				!hero.IsSilenced &&
				!hero.IsHexed
			) {
				const graveChill = hero.GetAbilityByName("visage_grave_chill")
				if (
					graveChill &&
					graveChill.IsValid &&
					graveChill.Level > 0 &&
					graveChill.Cooldown <= 0.1 &&
					hero.Mana >= graveChill.ManaCost
				) {
					// Cast on nearest enemy to slow
					let closestEnemy: Hero | undefined
					let minDist = Infinity
					const castRange = graveChill.CastRange > 0 ? graveChill.CastRange : 600
					for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
						if (
							enemy.IsValid &&
							enemy.IsAlive &&
							enemy.IsVisible &&
							enemy.IsEnemy(hero) &&
							!enemy.IsIllusion
						) {
							const dist = hero.Distance2D(enemy)
							if (dist <= castRange && dist < minDist) {
								minDist = dist
								closestEnemy = enemy
							}
						}
					}
					if (closestEnemy) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: closestEnemy.Index,
							ability: graveChill.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.autoSaveSleeper.Sleep(GameState.InputLag * 1000 + graveChill.CastPoint * 1000 + 100)
						return
					}
				}
			}

			if (
				this.visageSaveSilentGrave.value &&
				!hero.IsChanneling &&
				!hero.IsStunned &&
				!hero.IsSilenced &&
				!hero.IsHexed &&
				!hero.IsInvisible
			) {
				const silentGrave = hero.GetAbilityByName("visage_silent_as_the_grave")
				if (
					silentGrave &&
					silentGrave.IsValid &&
					silentGrave.Level > 0 &&
					silentGrave.Cooldown <= 0.1 &&
					hero.Mana >= silentGrave.ManaCost
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: silentGrave.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.autoSaveSleeper.Sleep(GameState.InputLag * 1000 + silentGrave.CastPoint * 1000 + 100)
					return
				}
			}

			// Visage: Gravekeeper's Cloak (Aghanim's Shard) - Stone Form
			if (
				this.visageSaveGravekeepersCloak.value &&
				!hero.IsChanneling &&
				!hero.IsStunned &&
				!hero.IsSilenced &&
				!hero.IsHexed
			) {
				const gravekeepersCloak = hero.GetAbilityByName("visage_gravekeepers_cloak")
				if (
					gravekeepersCloak &&
					gravekeepersCloak.IsValid &&
					gravekeepersCloak.Level > 0 &&
					gravekeepersCloak.Cooldown <= 0.1 &&
					hero.Mana >= gravekeepersCloak.ManaCost
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: gravekeepersCloak.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.autoSaveSleeper.Sleep(GameState.InputLag * 1000 + gravekeepersCloak.CastPoint * 1000 + 100)
					return
				}
			}
		}

		// --- Familiar Save (Stone Form) ---
		const familiars = this.getControllableFamiliars()
		for (const familiar of familiars) {
			const familiarHpPct = (familiar.HP / familiar.MaxHP) * 100
			if (familiarHpPct <= this.familiarSaveHpPct.value) {
				if (this.familiarSaveStoneForm.value && !familiar.IsChanneling) {
					const stoneForm = familiar.GetAbilityByName("visage_summon_familiars_stone_form")
					if (stoneForm && stoneForm.IsValid && stoneForm.Level > 0 && stoneForm.Cooldown <= 0.1) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [familiar],
							ability: stoneForm.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.autoSaveSleeper.Sleep(GameState.InputLag * 1000 + 600)
						return
					}
				}
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Cek enable/disable
		if (!this.comboEnabled.value) {
			return
		}

		// Auto Soul Assumption berjalan independen dari combo key
		this.executeAutoSoulAssumption(hero)

		// Auto Save (Low HP) - berjalan independen dari combo key
		this.executeAutoSave(hero)

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// Cari target hero musuh terdekat dengan posisi kursor mouse
		// Hanya pilih target yang berada dalam jarak cast range maksimum skill combo
		const maxCastRange = 1200
		const mousePos = InputManager.CursorOnWorld
		let bestTarget: Hero | undefined
		let minDist = Infinity

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				const distToCursor = enemy.Position.Distance2D(mousePos)
				const distToHero = hero.Distance2D(enemy)
				// Target harus dekat dengan kursor DAN dalam jarak cast range hero
				if (distToCursor < this.comboRadius.value && distToHero <= maxCastRange && distToCursor < minDist) {
					minDist = distToCursor
					bestTarget = enemy
				}
			}
		}

		// Auto Summon Familiars — cek apakah enabled di combo order grid
		const summonEnabled = this.comboSequenceGrid.IsEnabled("visage_summon_familiars")
		if (summonEnabled && !this.summonSleeper.Sleeping) {
			const familiars = this.getControllableFamiliars()
			if (familiars.length === 0) {
				const summonAbility = hero.GetAbilityByName("visage_summon_familiars")
				if (
					summonAbility &&
					summonAbility.IsValid &&
					summonAbility.Level > 0 &&
					summonAbility.Cooldown <= 0.1 &&
					hero.Mana >= summonAbility.ManaCost
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: summonAbility.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.summonSleeper.Sleep(GameState.InputLag * 1000 + 500)
					return
				}
			}
		}

		if (!bestTarget) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// ---------- FAMILIAR MICRO ----------
		const familiars = this.getControllableFamiliars()
		if (familiars.length > 0) {
			// Perintahkan familiar menyerang target
			this.orderFamiliarsAttack(familiars, bestTarget)

			// Auto Stone Form Chain Stun
			if (this.autoStoneFormEnabled.value) {
				this.executeStoneFormChainStun(familiars, bestTarget)
			}
		}

		// ---------- HERO SPELL COMBO ----------
		if (this.sleeper.Sleeping) {
			return
		}

		// Eksekusi skill sesuai urutan di comboSequenceGrid
		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			// Skip summon familiars di sini — sudah di-handle di atas
			if (spellName === "visage_summon_familiars") {
				continue
			}

			if (spellName === "visage_grave_chill") {
				const graveChill = hero.GetAbilityByName("visage_grave_chill")
				if (
					graveChill &&
					graveChill.IsValid &&
					graveChill.Level > 0 &&
					graveChill.Cooldown <= 0.1 &&
					hero.Mana >= graveChill.ManaCost &&
					!isTargetImmune
				) {
					const castRange = graveChill.CastRange > 0 ? graveChill.CastRange : 600
					if (hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: graveChill.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + graveChill.CastPoint * 1000 + 100)
						return
					}
				}
			} else if (spellName === "visage_soul_assumption") {
				const soulAssumption = hero.GetAbilityByName("visage_soul_assumption")
				if (
					soulAssumption &&
					soulAssumption.IsValid &&
					soulAssumption.Level > 0 &&
					soulAssumption.Cooldown <= 0.1 &&
					hero.Mana >= soulAssumption.ManaCost
				) {
					// Cek jumlah charge (stack count dari modifier)
					const currentCharges = this.getSoulAssumptionCharges(hero)

					if (currentCharges >= this.minSoulCharges.value) {
						const castRange = soulAssumption.CastRange > 0 ? soulAssumption.CastRange : 900
						if (hero.Distance2D(bestTarget) <= castRange) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: soulAssumption.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + soulAssumption.CastPoint * 1000 + 100)
							return
						}
					}
				}
			} else if (spellName === "visage_silent_as_the_grave") {
				const silentGrave = hero.GetAbilityByName("visage_silent_as_the_grave")
				if (
					silentGrave &&
					silentGrave.IsValid &&
					silentGrave.Level > 0 &&
					silentGrave.Cooldown <= 0.1 &&
					hero.Mana >= silentGrave.ManaCost
				) {
					// Silent As the Grave adalah skill no-target (buff invis + bonus damage)
					// Cast hanya jika target terlihat dan hero belum invisible
					if (!hero.IsInvisible) {
						const castRange = 900 // Jarak aman untuk memulai invis approach
						if (hero.Distance2D(bestTarget) <= castRange) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
								issuers: [hero],
								ability: silentGrave.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + silentGrave.CastPoint * 1000 + 100)
							return
						}
					}
				}
			}
		}

		// Fallback: Smart Orb Walk / Serang Target via shared orbwalker
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()

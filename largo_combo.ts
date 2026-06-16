import {
	Ability,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	InputManager,
	LocalPlayer,
	Menu,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"
import { executeOrbwalk } from "./orbwalker"

new (class LargoCombo {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Largo Combo")

	// Enable/Disable combo
	private readonly comboEnabled = this.entry.AddToggle(
		"Enable Combo",
		true,
		"Enable/Disable Largo combo script"
	)
	private readonly autoRhapsodySpells = this.entry.AddToggle(
		"Auto Rhapsody Skills",
		true,
		"Automatically cast selected Rhapsody songs when in Rhapsody state"
	)

	// Hotkeys untuk memilih song mana yang di-auto cast
	// Tekan sekali untuk toggle ON/OFF, auto cast hanya song yang dipilih
	private readonly fightSongKey = this.entry.AddKeybind(
		"Fight Song (Bullbelly Blitz) Key",
		"1",
		"Press to toggle Fight Song as selected Rhapsody auto-cast target"
	)
	private readonly doubleTimeKey = this.entry.AddKeybind(
		"Double Time (Hotfeet Hustle) Key",
		"2",
		"Press to toggle Double Time as selected Rhapsody auto-cast target"
	)
	private readonly goodVibrationsKey = this.entry.AddKeybind(
		"Good Vibrations (Island Elixir) Key",
		"3",
		"Press to toggle Good Vibrations as selected Rhapsody auto-cast target"
	)

	// State: song mana saja yang dipilih user
	private selectedRhapsodySongs = new Set<string>()
	// Debounce agar satu key press = satu toggle
	private readonly keySleeper = new TickSleeper()

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Largo combo")
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

	private comboSequenceGrid: any

	// Sleepers
	private readonly sleeper = new TickSleeper()
	private readonly rhapsodySleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("largo_croak_of_genius", [true, true, true, 0])
		defaultCombo.set("largo_frogstomp", [true, true, true, 1])
		defaultCombo.set("largo_catchy_lick", [true, true, true, 2])
		defaultCombo.set("largo_song_fight_song", [true, true, true, 3])
		defaultCombo.set("largo_amphibian_rhapsody", [true, true, true, 4])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			[
				"largo_croak_of_genius",
				"largo_frogstomp",
				"largo_catchy_lick",
				"largo_song_fight_song",
				"largo_amphibian_rhapsody"
			],
			defaultCombo
		)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_largo"
		)
	}





	// ----------------------------------------------------------------
	// Background Features
	// ----------------------------------------------------------------

	/**
	 * Handle hotkey press untuk memilih song Rhapsody.
	 * Tekan sekali = toggle song tersebut ON/OFF sebagai auto-cast target.
	 */
	private handleRhapsodySongHotkeys(): void {
		if (this.keySleeper.Sleeping) {
			return
		}

		// @ts-ignore
		const fightPressed = this.fightSongKey.isPressed
		// @ts-ignore
		const doublePressed = this.doubleTimeKey.isPressed
		// @ts-ignore
		const goodPressed = this.goodVibrationsKey.isPressed

		if (!fightPressed && !doublePressed && !goodPressed) {
			return
		}

		// Debounce: 200ms agar satu key press = satu toggle
		this.keySleeper.Sleep(200)

		if (fightPressed) {
			const name = "largo_song_fight_song"
			if (this.selectedRhapsodySongs.has(name)) {
				this.selectedRhapsodySongs.delete(name)
				console.log(`[LargoCombo] Rhapsody: Fight Song DESELECTED`)
			} else {
				this.selectedRhapsodySongs.add(name)
				console.log(`[LargoCombo] Rhapsody: Fight Song SELECTED`)
			}
		}

		if (doublePressed) {
			const name = "largo_song_double_time"
			if (this.selectedRhapsodySongs.has(name)) {
				this.selectedRhapsodySongs.delete(name)
				console.log(`[LargoCombo] Rhapsody: Double Time DESELECTED`)
			} else {
				this.selectedRhapsodySongs.add(name)
				console.log(`[LargoCombo] Rhapsody: Double Time SELECTED`)
			}
		}

		if (goodPressed) {
			const name = "largo_song_good_vibrations"
			if (this.selectedRhapsodySongs.has(name)) {
				this.selectedRhapsodySongs.delete(name)
				console.log(`[LargoCombo] Rhapsody: Good Vibrations DESELECTED`)
			} else {
				this.selectedRhapsodySongs.add(name)
				console.log(`[LargoCombo] Rhapsody: Good Vibrations SELECTED`)
			}
		}
	}

	/**
	 * Auto Rhapsody Skills — cast hanya song yang dipilih user via hotkey.
	 * Tanpa Aghanim: maksimal 1 song aktif sekaligus.
	 * Dengan Aghanim (Scepter): bisa 2 song sekaligus.
	 */
	private executeAutoRhapsodySpells(hero: Hero, target?: Hero): boolean {
		if (!this.autoRhapsodySpells.value || this.rhapsodySleeper.Sleeping) {
			return false
		}
		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return false
		}

		// Hanya berjalan jika memiliki buff Rhapsody
		if (!hero.HasBuffByName("modifier_largo_amphibian_rhapsody_self")) {
			return false
		}

		// Jika tidak ada song yang dipilih, tidak cast apapun
		if (this.selectedRhapsodySongs.size === 0) {
			return false
		}

		// Cek apakah hero punya Aghanim (bisa 2 song bersamaan)
		const hasAghanim = hero.HasBuffByName("modifier_item_ultimate_scepter_consumed") ||
			hero.HasBuffByName("modifier_item_ultimate_scepter")
		const maxSongs = hasAghanim ? 2 : 1

		// Cari target terdekat jika target tidak di-pass dari combo
		let castTarget = target
		if (!castTarget || !castTarget.IsValid || !castTarget.IsAlive) {
			let minDist = Infinity
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
					const dist = hero.Distance2D(enemy)
					if (dist <= 1200 && dist < minDist) {
						minDist = dist
						castTarget = enemy
					}
				}
			}
		}

		// Hitung berapa song yang saat ini aktif (sedang di-buff target/self)
		const songBuffMap: Record<string, string> = {
			"largo_song_fight_song": "modifier_largo_song_fight_song",
			"largo_song_double_time": "modifier_largo_song_double_time",
			"largo_song_good_vibrations": "modifier_largo_song_good_vibrations"
		}

		// Iterasi hanya song yang dipilih user
		const selectedList = Array.from(this.selectedRhapsodySongs)
		let castCount = 0

		for (const spellName of selectedList) {
			if (castCount >= maxSongs) {
				break
			}

			const ability = hero.GetAbilityByName(spellName)
			if (
				!ability ||
				!ability.IsValid ||
				ability.Cooldown > 0.1 ||
				hero.Mana < ability.ManaCost
			) {
				continue
			}

			const isOffensive =
				spellName === "largo_song_fight_song" ||
				spellName === "largo_song_double_time"
			const isSupportive = spellName === "largo_song_good_vibrations"

			if (isOffensive) {
				if (!castTarget) {
					continue
				}
				if (castTarget.IsMagicImmune || castTarget.IsDebuffImmune) {
					continue
				}
			}

			const spellTarget = isSupportive ? hero : (castTarget || hero)

			if (this.executeComboAbility(hero, ability, spellTarget!)) {
				console.log(`[LargoCombo] Auto Rhapsody cast: ${spellName}`)
				castCount++
				// Jika bisa 2 song (Aghanim), tidak sleep dulu — langsung coba cast song ke-2
				if (castCount >= maxSongs) {
					this.rhapsodySleeper.Sleep(1000) // BEAT INTERVAL: 1 sec
					return true
				}
			}
		}

		if (castCount > 0) {
			this.rhapsodySleeper.Sleep(1000)
			return true
		}

		// Jika semua selected song tidak bisa di-cast (cooldown/no mana), exit Rhapsody
		const allOnCooldown = selectedList.every(spellName => {
			const ability = hero.GetAbilityByName(spellName)
			return !ability || !ability.IsValid || ability.Cooldown > 0.5 || hero.Mana < ability.ManaCost
		})

		if (allOnCooldown) {
			const rhapsody = hero.GetAbilityByName("largo_amphibian_rhapsody")
			if (
				rhapsody &&
				rhapsody.IsValid &&
				rhapsody.Cooldown <= 0.1 &&
				hero.Mana >= rhapsody.ManaCost
			) {
				const exitTarget = castTarget || hero
				if (this.executeComboAbility(hero, rhapsody, exitTarget)) {
					console.log(`[LargoCombo] Auto Rhapsody exit (selected songs on cooldown)`)
					this.rhapsodySleeper.Sleep(
						GameState.InputLag * 1000 + rhapsody.CastPoint * 1000 + 100
					)
					return true
				}
			}
		}

		return false
	}

	/**
	 * Auto Songs — background toggle management.

	 *
	 * Without Aghanim only 1 song active at a time.
	 * With Aghanim (Scepter) can have 2.
	 * Songs use a double-click mechanic: first cast primes, second within ~1s activates.
	 * We handle this via songSleeper delay between casts.
	 */


	// ----------------------------------------------------------------
	// Combo Ability Execution
	// ----------------------------------------------------------------

	/**
	 * Eksekusi ability terhadap target, handling berbagai behavior type.
	 */
	private executeComboAbility(hero: Hero, ability: Ability, target: Hero): boolean {
		const isNoTarget = ability.HasBehavior(
			DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET
		)
		const isTarget = ability.HasBehavior(
			DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET
		)
		const isPosition = ability.HasBehavior(
			DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT
		)

		if (isNoTarget) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
				issuers: [hero],
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		} else if (isTarget) {
			const isAllyTarget =
				ability.Name === "largo_island_elixir" ||
				ability.Name === "largo_croak_of_genius"
			const castTarget = isAllyTarget ? hero : target
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
				issuers: [hero],
				target: castTarget.Index,
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		} else if (isPosition) {
			const castPos = target.Position.Clone()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
				issuers: [hero],
				position: castPos,
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		}
		return false
	}

	// ----------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.rhapsodySleeper.Sleep(0)
		this.comboSequenceGrid = null
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.comboEnabled.value) {
			return
		}

		// Clean up Rhapsody sub-skills from the combo sequence grid if they exist
		if (this.comboSequenceGrid) {
			let updated = false
			for (const spell of ["largo_song_fight_song", "largo_song_double_time", "largo_song_good_vibrations"]) {
				if (this.comboSequenceGrid.enabledValues.has(spell)) {
					this.comboSequenceGrid.enabledValues.delete(spell)
					updated = true
				}
			}
			if (updated) {
				this.comboSequenceGrid.values = this.comboSequenceGrid.values.filter(
					(v: string) =>
						v !== "largo_song_fight_song" &&
						v !== "largo_song_double_time" &&
						v !== "largo_song_good_vibrations"
				)
				this.comboSequenceGrid.Update()
				Menu.Base.SaveConfigASAP = true
			}
		}

		// Background features — jalan tanpa combo key
		this.handleRhapsodySongHotkeys()
		this.executeAutoRhapsodySpells(hero)

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// --- Diagnostics log ---
		if (!this.sleeper.Sleeping) {
			const activeSpells = hero.Spells
				.map((s, idx) => s ? `${idx}:${s.Name}(hidden=${s.IsHidden},level=${s.Level})` : `${idx}:null`)
				.filter(s => !s.includes("null"))
				.join(", ")
			console.log(`[LargoCombo] Hero Buffs: ${hero.Buffs.map(b => b.Name).join(", ")}`)
			console.log(`[LargoCombo] Spells: ${activeSpells}`)
		}

		// --- Target Selection (nearest to cursor) ---
		const maxCastRange = 1200
		const mousePos = InputManager.CursorOnWorld
		let bestTarget: Hero | undefined
		let minDist = Infinity

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				const distToCursor = enemy.Position.Distance2D(mousePos)
				const distToHero = hero.Distance2D(enemy)
				if (distToCursor < this.comboRadius.value && distToHero <= maxCastRange && distToCursor < minDist) {
					minDist = distToCursor
					bestTarget = enemy
				}
			}
		}

		if (!bestTarget) {
			return
		}



		// --- Hero Spell Combo ---
		if (this.sleeper.Sleeping) {
			return
		}

		if (this.executeAutoRhapsodySpells(hero, bestTarget)) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			const ability = hero.GetAbilityByName(spellName)
			if (
				!ability ||
				!ability.IsValid ||
				ability.IsHidden ||
				ability.Level <= 0 ||
				ability.Cooldown > 0.1
			) {
				continue
			}

			const activeIndex = hero.Spells.indexOf(ability)

			// Skip jika ability tidak di active HUD slots (0-5) untuk Q/W/E
			const isQWE =
				spellName === "largo_croak_of_genius" ||
				spellName === "largo_frogstomp" ||
				spellName === "largo_catchy_lick"

			if (isQWE) {
				if (activeIndex === -1 || activeIndex > 5) {
					continue
				}
			}

			// Ultimate: handling untuk wujud rhapsody (toggle on/off)
			if (spellName === "largo_amphibian_rhapsody") {
				if (hero.HasBuffByName("modifier_largo_amphibian_rhapsody_self")) {
					// Kita di wujud rhapsody. Hanya boleh exit (cast Rhapsody lagi)
					// jika semua skill rhapsody (blitz, hustle, elixir) sudah tidak bisa di-cast.
					const blitz = hero.GetAbilityByName("largo_song_fight_song")
					const hustle = hero.GetAbilityByName("largo_song_double_time")
					const elixir = hero.GetAbilityByName("largo_song_good_vibrations")

					const isReady = (abil: Ability | undefined) => {
						return (
							abil &&
							abil.IsValid &&
							abil.Level > 0 &&
							abil.Cooldown <= 0.5 &&
							hero.Mana >= abil.ManaCost &&
							hero.Spells.indexOf(abil) >= 0 &&
							hero.Spells.indexOf(abil) <= 5
						)
					}

					if (isReady(blitz) || isReady(hustle) || isReady(elixir)) {
						continue
					}
				}
			}

			if (hero.Mana < ability.ManaCost) {
				continue
			}

			// --- Special handling per ability type ---



			// Grab terkait damage/kendali: skip jika target immune
			if (
				(spellName === "largo_croak_of_genius" ||
					spellName === "largo_frogstomp" ||
					spellName === "largo_catchy_lick") &&
				isTargetImmune
			) {
				continue
			}

			const castRange = ability.CastRange > 0 ? ability.CastRange : 600
			if (hero.Distance2D(bestTarget) > castRange) {
				continue
			}

			console.log(`[LargoCombo] Attempting to cast: ${spellName} (slot: ${activeIndex}, level: ${ability.Level}, CD: ${ability.Cooldown})`)
			if (this.executeComboAbility(hero, ability, bestTarget)) {
				console.log(`[LargoCombo] Order sent for: ${spellName}`)
				
				const sleepDuration = GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100
				this.sleeper.Sleep(sleepDuration)
				

				return
			}
		}

		// Fallback: Smart Orb Walk atau pergerakan saat Rhapsody
		if (hero.HasBuffByName("modifier_largo_amphibian_rhapsody_self")) {
			// Largo tidak bisa menyerang dalam wujud Rhapsody, cukup bergerak mengikuti target
			hero.MoveTo(bestTarget.Position)
		} else {
			executeOrbwalk(hero, bestTarget, this.sleeper, {
				enabled: this.smartOrbWalkEnabled.value,
				safeDistancePct: this.smartOrbWalkDistancePct.value,
				stopToCancel: this.smartOrbWalkStopCancel.value
			})
		}
	}
})()

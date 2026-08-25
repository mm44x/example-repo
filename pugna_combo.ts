import {
	Ability,
	Color,
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
	Rectangle,
	RendererSDK,
	TickSleeper,
	Unit,
	Vector2,
	Vector3,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"pugna_nether_blast",
	"pugna_decrepify",
	"pugna_nether_ward",
	"pugna_life_drain"
]

new (class PugnaCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Pugna Combo", "panorama/images/heroes/icons/npc_dota_hero_pugna_png.vtex_c", "", 0)

	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true)
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Pugna combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink", "item_dagon", "item_ethereal_blade", "item_veil_of_discord", "item_aether_lens", "item_cyclone", "item_glimmer_cape", "item_sheepstick"],
		new Map([
			["item_blink", true],
			["item_dagon", true],
			["item_ethereal_blade", true],
			["item_veil_of_discord", true],
			["item_aether_lens", true],
			["item_cyclone", true],
			["item_glimmer_cape", true],
			["item_sheepstick", true]
		]),
		"Toggle item usage in the combo"
	)

	private readonly blinkKey = this.entry.AddKeybind("Blink Key", "Space")
	private readonly blinkSleeper = new TickSleeper()

	private readonly smartOrbWalkEnabled = this.entry.AddToggle("Enable Smart Orb Walk", true)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider("Orb Walk Safe Distance %", 80, 10, 100, 5)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle("Stop-to-Cancel Backswing", false)

	// Spam Nether Blast
	private readonly spamBlastNode = this.entry.AddNode("Spam Nether Blast")
	private readonly spamBlastEnabled = this.spamBlastNode.AddToggle("Enable Spam Blast", true)
	private readonly spamBlastKey = this.spamBlastNode.AddKeybind("Spam Blast Key", "2")
	private readonly spamBlastSleeper = new TickSleeper()

	// Heal Ally
	private readonly healAllyNode = this.entry.AddNode("Heal Ally")
	private readonly healAllyEnabled = this.healAllyNode.AddToggle("Enable Heal Ally", true)
	private readonly healAllyKey = this.healAllyNode.AddKeybind("Heal Ally Key", "4")
	private readonly healAllyHpPct = this.healAllyNode.AddSlider("Heal Ally HP %", 40, 10, 90, 5)
	private readonly healAllyUseDecrepify = this.healAllyNode.AddToggle("Use Decrepify (heal)", true)
	private readonly healAllyUseLifeDrain = this.healAllyNode.AddToggle("Use Life Drain (heal)", true)
	private readonly healAllySleeper = new TickSleeper()

	// HUD
	private readonly showHud = this.entry.AddToggle("Show Status HUD", true)
	private statusHudPos = new Vector2(50, 400)
	private isDraggingStatus = false

	private comboSequenceGrid: any
	private readonly sleeper = new TickSleeper()
	private readonly lifeDrainSleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		COMBO_SPELLS.forEach((name, i) => defaultCombo.set(name, [true, true, true, i]))

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			COMBO_SPELLS,
			defaultCombo
		)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return LocalPlayer?.Hero?.IsValid && LocalPlayer.Hero.Name === "npc_dota_hero_pugna"
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.blinkSleeper.Sleep(0)
		this.spamBlastSleeper.Sleep(0)
		this.healAllySleeper.Sleep(0)
		this.lifeDrainSleeper.Sleep(0)
		this.comboSequenceGrid = null
	}

	// --- Cast helpers ---

	private castNoTarget(issuer: Hero, ability: Ability, queue = false): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
			issuers: [issuer],
			ability: ability.Index,
			queue,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castTarget(issuer: Hero, ability: Ability, target: Unit, queue = false): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
			issuers: [issuer],
			target: target.Index,
			ability: ability.Index,
			queue,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castPosition(issuer: Hero, ability: Ability, pos: Vector3, queue = false): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
			issuers: [issuer],
			position: pos,
			ability: ability.Index,
			queue,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private sleepAfterCast(_ability: Ability): void {
		// Jeda pendek antar order — cukup untuk memisahkan order,
		// tidak menunggu CastPoint penuh (guard IsInAbilityPhase yang menunggu cast selesai)
		this.sleeper.Sleep(GameState.InputLag * 1000 + 150)
	}

	// --- Item casting ---

	private tryCastItem(hero: Hero, itemName: string, target: Unit, queue = false): Ability | undefined {
		const item = hero.Items.find(i => i.Name === itemName)
		if (item && item.IsValid && item.CanBeUsable && !hero.IsMuted && hero.Mana >= item.ManaCost && item.Cooldown <= 0.1) {
			if (item.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
				this.castTarget(hero, item, target, queue)
				return item
			}
			if (item.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)) {
				this.castNoTarget(hero, item, queue)
				return item
			}
		}
		return undefined
	}

	// --- Blink ---

	private doBlink(hero: Hero, position: Vector3): boolean {
		if (!this.itemsSelector.IsEnabled("item_blink") || this.blinkSleeper.Sleeping) return false
		const blink = hero.Items.find(i => i.Name === "item_blink")
		if (!blink || !blink.IsValid || blink.Cooldown > 0.1 || !blink.CanBeUsable || hero.IsMuted || hero.Mana < blink.ManaCost) return false
		const dir = position.Subtract(hero.Position)
		const dist = dir.Length2D
		const blinkRange = blink.CastRange > 0 ? blink.CastRange : 1200
		const clamped = Math.min(dist, blinkRange)
		const blinkPos = dist > 0.1 ? hero.Position.Add(dir.Normalize().MultiplyScalar(clamped)) : position.Clone()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
			issuers: [hero],
			position: blinkPos,
			ability: blink.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
		this.blinkSleeper.Sleep(GameState.InputLag * 1000 + 150)
		return true
	}

	private handleBlinkKey(hero: Hero): boolean {
		// @ts-ignore
		if (!this.blinkKey.isPressed) return false
		return this.doBlink(hero, InputManager.CursorOnWorld)
	}

	// --- Item helpers ---

	private getDagonItem(hero: Hero): Ability | undefined {
		for (const name of ["item_dagon_5", "item_dagon_4", "item_dagon_3", "item_dagon_2", "item_dagon"]) {
			const item = hero.Items.find(i => i.Name === name)
			if (item && item.IsValid) return item
		}
		return undefined
	}

	// --- Spam Nether Blast ---

	private handleSpamBlast(hero: Hero): boolean {
		if (!this.spamBlastEnabled.value || this.spamBlastSleeper.Sleeping) return false
		// @ts-ignore
		if (!this.spamBlastKey.isPressed) return false
		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced || hero.IsChanneling) return false

		const blast = hero.GetAbilityByName("pugna_nether_blast")
		if (!blast || !blast.IsValid || blast.Level <= 0 || blast.Cooldown > 0.1 || hero.Mana < blast.ManaCost) return false

		const castPos = this.clampToCastRange(hero, blast, InputManager.CursorOnWorld)
		this.castPosition(hero, blast, castPos)
		this.spamBlastSleeper.Sleep(GameState.InputLag * 1000 + blast.CastPoint * 1000 + 100)
		return true
	}

	// --- Heal Ally ---

	private handleHealAlly(hero: Hero): boolean {
		if (!this.healAllyEnabled.value || this.healAllySleeper.Sleeping) return false
		// @ts-ignore
		if (!this.healAllyKey.isPressed) return false
		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced || hero.IsChanneling) return false

		// Find lowest HP ally (not self) within range
		let bestAlly: Hero | undefined
		let lowestHpPct = Infinity
		const range = 800

		for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
			if (!ally.IsValid || !ally.IsAlive || !ally.IsVisible || ally.IsEnemy(hero) || ally.Index === hero.Index) continue
			if (hero.Distance2D(ally) > range) continue
			const hpPct = (ally.HP / ally.MaxHP) * 100
			if (hpPct < lowestHpPct) {
				lowestHpPct = hpPct
				bestAlly = ally
			}
		}

		if (!bestAlly || lowestHpPct > this.healAllyHpPct.value) return false

		// Decrepify on ally = heal
		if (this.healAllyUseDecrepify.value) {
			const decrepify = hero.GetAbilityByName("pugna_decrepify")
			if (decrepify && decrepify.IsValid && decrepify.Level > 0 && decrepify.Cooldown <= 0.1 && hero.Mana >= decrepify.ManaCost) {
				this.castTarget(hero, decrepify, bestAlly)
				this.healAllySleeper.Sleep(GameState.InputLag * 1000 + decrepify.CastPoint * 1000 + 100)
				return true
			}
		}

		// Life Drain on ally = heal (channel)
		if (this.healAllyUseLifeDrain.value && !hero.IsChanneling) {
			const lifeDrain = hero.GetAbilityByName("pugna_life_drain")
			if (lifeDrain && lifeDrain.IsValid && lifeDrain.Level > 0 && lifeDrain.Cooldown <= 0.1 && hero.Mana >= lifeDrain.ManaCost) {
				this.castTarget(hero, lifeDrain, bestAlly)
				this.healAllySleeper.Sleep(GameState.InputLag * 1000 + lifeDrain.CastPoint * 1000 + 100)
				return true
			}
		}

		return false
	}

	// --- Life Drain auto re-cast ---

	private handleLifeDrainRecast(hero: Hero): boolean {
		if (this.lifeDrainSleeper.Sleeping) return false

		const lifeDrain = hero.GetAbilityByName("pugna_life_drain")
		if (!lifeDrain || !lifeDrain.IsValid || lifeDrain.Level <= 0 || lifeDrain.Cooldown > 0.1 || hero.Mana < lifeDrain.ManaCost) return false

		// Only if we were draining recently (channel broke) and there's a new target
		const castRange = lifeDrain.CastRange > 0 ? lifeDrain.CastRange : 600

		// Find nearest enemy hero in range
		let bestTarget: Hero | undefined
		let bestDist = Infinity
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (!enemy.IsValid || !enemy.IsAlive || !enemy.IsVisible || !enemy.IsEnemy(hero) || enemy.IsIllusion) continue
			const d = hero.Distance2D(enemy)
			if (d <= castRange && d < bestDist) {
				bestDist = d
				bestTarget = enemy
			}
		}

		if (!bestTarget) return false

		this.castTarget(hero, lifeDrain, bestTarget)
		this.lifeDrainSleeper.Sleep(GameState.InputLag * 1000 + lifeDrain.CastPoint * 1000 + 100)
		return true
	}

	// --- Utility ---

	private clampToCastRange(hero: Hero, ability: Ability, target: Vector3): Vector3 {
		const castRange = ability.CastRange > 0 ? ability.CastRange : 900
		const dir = target.Subtract(hero.Position)
		const dist = dir.Length2D
		if (dist <= castRange) return target.Clone()
		return hero.Position.Add(dir.Normalize().MultiplyScalar(castRange))
	}

	// --- HUD Draw ---

	private drawPanel(pos: Vector2, dragFlag: { val: boolean }, lines: { text: string; size: number; weight: number; color: Color }[]): void {
		const mousePos = InputManager.CursorOnScreen
		const mouseDown = InputManager.IsMouseKeyDown(VMouseKeys.MK_LBUTTON)
		const padX = 6, padY = 4, lineH = 18
		const maxW = Math.max(...lines.map(l => RendererSDK.GetTextSize(l.text, RendererSDK.DefaultFontName, l.size, l.weight).x))
		const panelW = maxW + padX * 2
		const panelH = lines.length * lineH + padY * 2
		const panelRect = new Rectangle(pos, new Vector2(panelW, panelH))

		if (mouseDown) {
			if (!dragFlag.val && panelRect.Contains(mousePos)) dragFlag.val = true
			if (dragFlag.val) pos.CopyFrom(mousePos.Subtract(new Vector2(panelW / 2, lineH)))
		} else {
			dragFlag.val = false
		}

		RendererSDK.FilledRect(pos, new Vector2(panelW, panelH), Color.Black.SetA(255))

		let y = pos.y + padY
		for (const l of lines) {
			RendererSDK.Text(l.text, new Vector2(pos.x + padX, y), l.color, RendererSDK.DefaultFontName, l.size, l.weight)
			y += lineH
		}
	}

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero) return
		if (!LocalPlayer?.Hero?.IsAlive) return

		// @ts-ignore
		const comboPressed = this.comboKey.isPressed
		// @ts-ignore
		const spamPressed = this.spamBlastKey.isPressed
		// @ts-ignore
		const healPressed = this.healAllyKey.isPressed

		if (this.showHud.value) {
			const statusLines = [
				{ text: "Pugna Status", size: 14, weight: 700, color: Color.Yellow },
				{ text: comboPressed ? "Combo: ACTIVE" : "Combo: idle", size: 13, weight: 400, color: comboPressed ? Color.Green : Color.Gray },
				{ text: spamPressed ? "Spam Blast: ACTIVE" : "Spam Blast: idle", size: 13, weight: 400, color: spamPressed ? Color.Green : Color.Gray },
				{ text: healPressed ? "Heal Ally: ACTIVE" : "Heal Ally: idle", size: 13, weight: 400, color: healPressed ? Color.Green : Color.Gray },
				{ text: this.getSpellDebug(), size: 11, weight: 400, color: Color.LightGray },
			]
			this.drawPanel(this.statusHudPos, { val: this.isDraggingStatus }, statusLines)
		}
	}

	private getSpellDebug(): string {
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid) return "Spells: no hero"
		const parts = COMBO_SPELLS.map(name => {
			const ab = hero.GetAbilityByName(name)
			if (!ab || !ab.IsValid || ab.Level <= 0) return `${name.split("_")[2]}=no`
			return `${name.split("_")[2]}=${this.comboSequenceGrid?.IsEnabled(name) ? "on" : "off"}/${ab.Cooldown.toFixed(1)}s`
		})
		return "Spells: " + parts.join(" ")
	}

	// --- Main Loop ---

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) return

		const hero = LocalPlayer!.Hero!
		if (!hero.IsAlive) return
		if (!this.comboEnabled.value) return

		if (this.handleBlinkKey(hero)) return
		if (this.handleSpamBlast(hero)) return

		// Heal Ally — key-driven (hold key)
		if (this.handleHealAlly(hero)) return

		// @ts-ignore
		if (!this.comboKey.isPressed) return

		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced) return

		// Drain berjalan: semua order berikutnya di-QUEUE supaya tidak memutus channel.
		// (kecuali walking — itu memang memutus drain dan itu normal)
		const isDraining = hero.IsChanneling
		if (isDraining) {
			// Auto re-cast kalau channel putus
			this.handleLifeDrainRecast(hero)
		}
		const queued = isDraining

		// Masih dalam fase cast (cast point) — tunggu selesai sebelum order berikutnya,
		// supaya order baru tidak membatalkan cast yang sedang berlangsung
		if (!queued && hero.IsInAbilityPhase) return

		const bestTarget = this.findBestTarget(hero)
		if (!bestTarget) return

		const distToTarget = hero.Distance2D(bestTarget)

		// Auto blink — tidak saat drain (blink = gerakan, memutus channel)
		if (!queued && distToTarget > 800) {
			if (this.doBlink(hero, bestTarget.Position)) return
		}

		if (this.sleeper.Sleeping) return

		const isImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// --- Disable items (duluan, biar target diam) ---
		if (!isImmune) {
			if (this.itemsSelector.IsEnabled("item_sheepstick") && distToTarget <= 600) {
				const hex = this.tryCastItem(hero, "item_sheepstick", bestTarget, queued)
				if (hex) { this.sleeper.Sleep(GameState.InputLag * 1000 + 150); return }
			}
			if (this.itemsSelector.IsEnabled("item_cyclone") && distToTarget <= 650) {
				const eul = this.tryCastItem(hero, "item_cyclone", bestTarget, queued)
				if (eul) { this.sleeper.Sleep(GameState.InputLag * 1000 + 150); return }
			}
		}

		// --- Spell Combo (DynamicImageSelector order) — sebelum damage items biar skill inti selalu keluar ---
		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) continue

			const ability = hero.GetAbilityByName(spellName)
			if (!ability || !ability.IsValid || ability.IsHidden || ability.Level <= 0 || ability.Cooldown > 0.1) continue
			if (hero.Mana < ability.ManaCost) continue

			switch (spellName) {
				case "pugna_nether_blast": {
					// Point target: cast at max range towards enemy (delay 0.9s)
					const castPos = this.clampToCastRange(hero, ability, bestTarget.Position)
					this.castPosition(hero, ability, castPos, queued)
					this.sleepAfterCast(ability)
					return
				}
				case "pugna_decrepify": {
					if (isImmune) continue
					const castRange = ability.CastRange > 0 ? ability.CastRange : 600
					if (distToTarget > castRange) continue
					this.castTarget(hero, ability, bestTarget, queued)
					this.sleepAfterCast(ability)
					return
				}
				case "pugna_nether_ward": {
					// Place ward between hero and target (or at target)
					const castPos = this.clampToCastRange(hero, ability, bestTarget.Position)
					this.castPosition(hero, ability, castPos, queued)
					this.sleepAfterCast(ability)
					return
				}
				case "pugna_life_drain": {
					if (isImmune) continue
					const castRange = ability.CastRange > 0 ? ability.CastRange : 600
					if (distToTarget > castRange) continue
					this.castTarget(hero, ability, bestTarget, queued)
					const channelTime = ability.CastPoint > 0 ? ability.CastPoint : 0.3
					this.sleeper.Sleep(GameState.InputLag * 1000 + channelTime * 1000 + 200)
					return
				}
			}
		}

		// --- Damage items (setelah skill, biar skill inti tidak tertahan) ---
		if (!isImmune) {
			if (this.itemsSelector.IsEnabled("item_veil_of_discord") && distToTarget <= 700) {
				const veil = this.tryCastItem(hero, "item_veil_of_discord", bestTarget, queued)
				if (veil) { this.sleeper.Sleep(GameState.InputLag * 1000 + 150); return }
			}
			if (this.itemsSelector.IsEnabled("item_ethereal_blade") && distToTarget <= 800) {
				const eth = this.tryCastItem(hero, "item_ethereal_blade", bestTarget, queued)
				if (eth) { this.sleeper.Sleep(GameState.InputLag * 1000 + 150); return }
			}
			if (this.itemsSelector.IsEnabled("item_dagon")) {
				const dagon = this.getDagonItem(hero)
				if (dagon && dagon.IsValid && dagon.CanBeUsable && hero.Mana >= dagon.ManaCost && dagon.Cooldown <= 0.1) {
					const r = dagon.CastRange > 0 ? dagon.CastRange : 800
					if (distToTarget <= r) { this.castTarget(hero, dagon, bestTarget, queued); this.sleeper.Sleep(GameState.InputLag * 1000 + 150); return }
				}
			}
		}

		// Glimmer Cape — self-cast saat low HP (emergency, bukan bagian isImmune)
		if (this.itemsSelector.IsEnabled("item_glimmer_cape")) {
			const hpPct = (hero.HP / hero.MaxHP) * 100
			if (hpPct < 40) {
				const glimmer = hero.Items.find(i => i.Name === "item_glimmer_cape")
				if (glimmer && glimmer.IsValid && glimmer.CanBeUsable && !hero.IsMuted && glimmer.Cooldown <= 0.1 && hero.Mana >= glimmer.ManaCost) {
					this.castTarget(hero, glimmer, hero, queued)
					this.sleeper.Sleep(GameState.InputLag * 1000 + 150)
					return
				}
			}
		}

		// Fallback orbwalk — skip saat drain (move order memutus channel)
		if (!queued) {
			executeOrbwalk(hero, bestTarget, this.sleeper, {
				enabled: this.smartOrbWalkEnabled.value,
				safeDistancePct: this.smartOrbWalkDistancePct.value,
				stopToCancel: this.smartOrbWalkStopCancel.value
			})
		}
	}

	private findBestTarget(hero: Hero): Hero | undefined {
		const mousePos = InputManager.CursorOnWorld
		let best: Hero | undefined
		let minDist = Infinity
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (!enemy.IsValid || !enemy.IsAlive || !enemy.IsVisible || !enemy.IsEnemy(hero) || enemy.IsIllusion) continue
			const dc = enemy.Position.Distance2D(mousePos)
			const dh = hero.Distance2D(enemy)
			if (dc < this.comboRadius.value && dh <= 1200 && dc < minDist) {
				minDist = dc
				best = enemy
			}
		}
		return best
	}
})()

import {
	Ability,
	Color,
	Creep,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameRules,
	GameState,
	Hero,
	InputManager,
	LocalPlayer,
	Menu,
	Rectangle,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"tinker_laser",
	"tinker_march_of_the_machines",
	"tinker_deploy_turrets",
	"tinker_warp_grenade",
	"tinker_rearm"
]

const RELEVANT_SPELLS = [
	"tinker_laser",
	"tinker_march_of_the_machines",
	"tinker_deploy_turrets",
	"tinker_warp_grenade"
]

let spellInfoFrameCount = 0
const debugSpellInfo: string[] = []

new (class TinkerCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Tinker Combo", "panorama/images/heroes/icons/npc_dota_hero_tinker_png.vtex_c", "", 0)

	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true)
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Tinker combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink", "item_sheepstick", "item_ethereal_blade", "item_dagon", "item_shivas_guard", "item_bottle"],
		new Map([
			["item_blink", true],
			["item_sheepstick", true],
			["item_ethereal_blade", true],
			["item_dagon", true],
			["item_shivas_guard", true],
			["item_bottle", true]
		]),
		"Toggle item usage in the combo"
	)

	private readonly blinkKey = this.entry.AddKeybind("Blink Key", "Space")
	private readonly blinkSleeper = new TickSleeper()

	private readonly smartOrbWalkEnabled = this.entry.AddToggle("Enable Smart Orb Walk", true)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider("Orb Walk Safe Distance %", 80, 10, 100, 5)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle("Stop-to-Cancel Backswing", false)

	// Combo Skills toggles
	private readonly comboSkillsNode = this.entry.AddNode("Combo Skills")
	private readonly useLaser = this.comboSkillsNode.AddToggle("Use Laser", true)
	private readonly useMarch = this.comboSkillsNode.AddToggle("Use March of the Machines", true)
	private readonly useTurrets = this.comboSkillsNode.AddToggle("Use Deploy Turrets", true)
	private readonly useWarpFlare = this.comboSkillsNode.AddToggle("Use Warp Flare (Shard)", true)

	// Spam March
	private readonly spamMarchNode = this.entry.AddNode("Spam March")
	private readonly spamMarchEnabled = this.spamMarchNode.AddToggle("Enable Spam March", true)
	private readonly spamMarchKey = this.spamMarchNode.AddKeybind("Spam March Key", "2")
	private readonly spamMarchRearm = this.spamMarchNode.AddToggle("Auto Rearm on Spam March", true)
	private readonly spamMarchSleeper = new TickSleeper()

	// Auto Farm
	private readonly autoFarmNode = this.entry.AddNode("Auto Farm")
	private readonly autoFarmToggleKey = this.autoFarmNode.AddKeybind("Auto Farm Toggle Key", "3")
	private isAutoFarming = false
	private readonly autoFarmMode = this.autoFarmNode.AddDropdown("Farm Mode", ["Jungle", "Lane"], 0)
	private readonly autoFarmUseMarch = this.autoFarmNode.AddToggle("Use March", true)
	private readonly autoFarmUseLaser = this.autoFarmNode.AddToggle("Use Laser", true)
	private readonly autoFarmRearm = this.autoFarmNode.AddToggle("Auto Rearm", true)
	private readonly autoFarmSleeper = new TickSleeper()
	private farmKeyWasPressed = false

	// HUD — dua panel terpisah: status + debug
	private readonly showHud = this.entry.AddToggle("Show Status HUD", true)
	private readonly showDebugHud = this.entry.AddToggle("Show Debug HUD", true)
	private statusHudPos = new Vector2(50, 400)
	private debugHudPos = new Vector2(50, 520)
	private isDraggingStatus = false
	private isDraggingDebug = false

	private readonly sleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return LocalPlayer?.Hero?.IsValid && LocalPlayer.Hero.Name === "npc_dota_hero_tinker"
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.blinkSleeper.Sleep(0)
		this.spamMarchSleeper.Sleep(0)
		this.autoFarmSleeper.Sleep(0)
		this.isAutoFarming = false
		this.farmKeyWasPressed = false
		debugSpellInfo.length = 0
		spellInfoFrameCount = 0
	}

	// --- Cast helpers ---

	private castNoTarget(issuer: Hero, ability: Ability): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
			issuers: [issuer],
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castTarget(issuer: Hero, ability: Ability, target: Hero): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
			issuers: [issuer],
			target: target.Index,
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castPosition(issuer: Hero, ability: Ability, pos: Vector3): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
			issuers: [issuer],
			position: pos,
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private sleepAfterCast(ability: Ability): void {
		this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
	}

	// --- Item casting ---

	private tryCastItem(hero: Hero, itemName: string, target: Hero): Ability | undefined {
		const item = hero.Items.find(i => i.Name === itemName)
		if (item && item.IsValid && item.CanBeUsable && !hero.IsMuted && hero.Mana >= item.ManaCost && item.Cooldown <= 0.1) {
			if (item.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
				this.castTarget(hero, item, target)
				return item
			}
			if (item.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)) {
				this.castNoTarget(hero, item)
				return item
			}
		}
		return undefined
	}

	private tryCastItemNoTarget(hero: Hero, itemName: string): Ability | undefined {
		const item = hero.Items.find(i => i.Name === itemName)
		if (
			item && item.IsValid && item.CanBeUsable && !hero.IsMuted &&
			hero.Mana >= item.ManaCost && item.Cooldown <= 0.1 &&
			item.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
		) {
			this.castNoTarget(hero, item)
			return item
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

	// --- Rearm logic ---

	private shouldRearm(hero: Hero): boolean {
		const spellOnCd = RELEVANT_SPELLS.some(name => {
			const ab = hero.GetAbilityByName(name)
			return ab && ab.IsValid && ab.Level > 0 && ab.Cooldown > 1
		})

		const itemOnCd = [
			this.itemsSelector.IsEnabled("item_sheepstick") && hero.Items.find(i => i.Name === "item_sheepstick"),
			this.itemsSelector.IsEnabled("item_ethereal_blade") && hero.Items.find(i => i.Name === "item_ethereal_blade"),
			this.itemsSelector.IsEnabled("item_dagon") && this.getDagonItem(hero),
			this.itemsSelector.IsEnabled("item_shivas_guard") && hero.Items.find(i => i.Name === "item_shivas_guard")
		].some(item => item && item.IsValid && item.Cooldown > 1)

		return spellOnCd || itemOnCd
	}

	private getDagonItem(hero: Hero): Ability | undefined {
		for (const name of ["item_dagon_5", "item_dagon_4", "item_dagon_3", "item_dagon_2", "item_dagon"]) {
			const item = hero.Items.find(i => i.Name === name)
			if (item && item.IsValid) return item
		}
		return undefined
	}

	private hasWarpGrenade(hero: Hero): boolean {
		const wg = hero.GetAbilityByName("tinker_warp_grenade")
		if (!wg || !wg.IsValid) return false
		return !wg.IsHidden
	}

	// --- Spam March ---

	private handleSpamMarch(hero: Hero): boolean {
		if (!this.spamMarchEnabled.value || this.spamMarchSleeper.Sleeping) return false
		// @ts-ignore
		if (!this.spamMarchKey.isPressed) return false
		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced || hero.IsChanneling) return false

		if (this.spamMarchRearm.value) {
			const march = hero.GetAbilityByName("tinker_march_of_the_machines")
			if (march && march.IsValid && march.Level > 0 && march.Cooldown > 0.5) {
				const rearm = hero.GetAbilityByName("tinker_rearm")
				if (rearm && rearm.IsValid && rearm.Level > 0 && rearm.Cooldown <= 0.1 && hero.Mana >= rearm.ManaCost + march.ManaCost) {
					this.castNoTarget(hero, rearm)
					this.spamMarchSleeper.Sleep(GameState.InputLag * 1000 + (rearm.CastPoint > 0 ? rearm.CastPoint : 0.75) * 1000 + 200)
					return true
				}
			}
		}

		const march = hero.GetAbilityByName("tinker_march_of_the_machines")
		if (!march || !march.IsValid || march.Level <= 0 || march.Cooldown > 0.1 || hero.Mana < march.ManaCost) return false

		this.castPosition(hero, march, this.groundCastPos(hero, march, InputManager.CursorOnWorld))
		this.spamMarchSleeper.Sleep(GameState.InputLag * 1000 + march.CastPoint * 1000 + 100)
		return true
	}

	// --- Auto Farm ---

	private handleAutoFarmToggle(): void {
		// @ts-ignore
		const pressed = this.autoFarmToggleKey.isPressed
		if (pressed && !this.farmKeyWasPressed) {
			this.isAutoFarming = !this.isAutoFarming
		}
		this.farmKeyWasPressed = pressed
	}

	private findJungleMarchPosition(hero: Hero): Vector3 | undefined {
		const spawnBoxes = GameRules?.NeutralSpawnBoxes
		if (!spawnBoxes || spawnBoxes.length === 0) return undefined

		const neutralCreeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c => c.IsValid && c.IsAlive && c.IsVisible && c.IsNeutral
		)

		if (neutralCreeps.length === 0) {
			let nearest: Vector3 | undefined
			let nd = Infinity
			for (const box of spawnBoxes) {
				const d = hero.Distance2D(box.Center)
				if (d < nd && d < 2500) { nd = d; nearest = box.Center }
			}
			return nearest
		}

		const campCreeps = new Map<string, Creep[]>()
		for (const c of neutralCreeps) {
			const name = c.Spawner?.Name ?? "unknown"
			if (!campCreeps.has(name)) campCreeps.set(name, [])
			campCreeps.get(name)!.push(c)
		}

		const campCenters = new Map<string, Vector3>()
		for (const [name, creeps] of campCreeps) {
			let cx = 0, cy = 0, cz = 0
			for (const c of creeps) { cx += c.Position.x; cy += c.Position.y; cz += c.Position.z }
			campCenters.set(name, new Vector3(cx / creeps.length, cy / creeps.length, cz / creeps.length))
		}

		const names = Array.from(campCenters.keys())
		for (let i = 0; i < names.length; i++) {
			for (let j = i + 1; j < names.length; j++) {
				const a = campCenters.get(names[i])!, b = campCenters.get(names[j])!
				if (a.Distance2D(b) < 1200) {
					return new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
				}
			}
		}

		let nc: Vector3 | undefined, nd = Infinity
		for (const c of campCenters.values()) {
			const d = hero.Distance2D(c)
			if (d < nd) { nd = d; nc = c }
		}
		return nc
	}

	private findLaneMarchPosition(hero: Hero): Vector3 | undefined {
		const creeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c => c.IsValid && c.IsAlive && c.IsVisible && c.IsLaneCreep && c.IsEnemy(hero)
		)
		if (creeps.length === 0) return undefined

		let bestCluster: Creep[] = [], bestDist = Infinity
		const visited = new Set<number>()
		for (const c of creeps) {
			if (visited.has(c.Index)) continue
			const cluster: Creep[] = [c]
			visited.add(c.Index)
			for (const o of creeps) {
				if (!visited.has(o.Index) && c.Distance2D(o) < 500) { cluster.push(o); visited.add(o.Index) }
			}
			const d = hero.Distance2D(c.Position)
			if (d < bestDist) { bestDist = d; bestCluster = cluster }
		}
		if (bestCluster.length === 0) return undefined

		let cx = 0, cy = 0, cz = 0
		for (const c of bestCluster) { cx += c.Position.x; cy += c.Position.y; cz += c.Position.z }
		return new Vector3(cx / bestCluster.length, cy / bestCluster.length, cz / bestCluster.length)
	}

	private findLaserFarmTarget(hero: Hero): Creep | undefined {
		const creeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c => c.IsValid && c.IsAlive && c.IsVisible && c.IsEnemy(hero) &&
				hero.Distance2D(c) <= 600 && (c.IsNeutral || c.IsLaneCreep)
		)
		creeps.sort((a, b) => b.HP - a.HP)
		return creeps[0]
	}

	private handleAutoFarm(hero: Hero): boolean {
		if (!this.isAutoFarming || this.autoFarmSleeper.Sleeping) return false
		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced || hero.IsChanneling) return false

		const isJungle = this.autoFarmMode.SelectedID === 0

		if (this.autoFarmRearm.value) {
			const march = hero.GetAbilityByName("tinker_march_of_the_machines")
			const laser = hero.GetAbilityByName("tinker_laser")
			const needRearm =
				(this.autoFarmUseMarch.value && march && march.IsValid && march.Level > 0 && march.Cooldown > 1) ||
				(this.autoFarmUseLaser.value && laser && laser.IsValid && laser.Level > 0 && laser.Cooldown > 1)
			if (needRearm) {
				const rearm = hero.GetAbilityByName("tinker_rearm")
				if (rearm && rearm.IsValid && rearm.Level > 0 && rearm.Cooldown <= 0.1 && hero.Mana >= rearm.ManaCost) {
					this.castNoTarget(hero, rearm)
					this.autoFarmSleeper.Sleep(GameState.InputLag * 1000 + (rearm.CastPoint > 0 ? rearm.CastPoint : 0.75) * 1000 + 200)
					return true
				}
			}
		}

		if (this.autoFarmUseLaser.value) {
			const laser = hero.GetAbilityByName("tinker_laser")
			if (laser && laser.IsValid && laser.Level > 0 && laser.Cooldown <= 0.1) {
				const tgt = this.findLaserFarmTarget(hero)
				if (tgt && hero.Mana >= laser.ManaCost) {
					this.castTarget(hero, laser, tgt as unknown as Hero)
					this.autoFarmSleeper.Sleep(GameState.InputLag * 1000 + laser.CastPoint * 1000 + 100)
					return true
				}
			}
		}

		if (this.autoFarmUseMarch.value) {
			const march = hero.GetAbilityByName("tinker_march_of_the_machines")
			if (march && march.IsValid && march.Level > 0 && march.Cooldown <= 0.1 && hero.Mana >= march.ManaCost) {
				const tgt = isJungle ? this.findJungleMarchPosition(hero) : this.findLaneMarchPosition(hero)
				if (tgt) {
					this.castPosition(hero, march, this.groundCastPos(hero, march, tgt))
					this.autoFarmSleeper.Sleep(GameState.InputLag * 1000 + march.CastPoint * 1000 + 100)
					return true
				}
			}
		}
		return false
	}

	private groundCastPos(hero: Hero, ability: Ability, target: Vector3): Vector3 {
		const maxRange = ability.CastRange > 0 ? ability.CastRange : 900
		const dir = target.Subtract(hero.Position)
		const dist = dir.Length2D
		if (dist <= maxRange) return target.Clone()
		return hero.Position.Add(dir.Normalize().MultiplyScalar(maxRange))
	}

	// --- HUD Draw (dua panel terpisah) ---

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
		const spamPressed = this.spamMarchKey.isPressed

		if (this.showHud.value) {
			const statusLines = [
				{ text: "Tinker Status", size: 14, weight: 700, color: Color.Yellow },
				{ text: comboPressed ? "Combo: ACTIVE" : "Combo: idle", size: 13, weight: 400, color: comboPressed ? Color.Green : Color.Gray },
				{ text: spamPressed ? "Spam March: ACTIVE" : "Spam March: idle", size: 13, weight: 400, color: spamPressed ? Color.Green : Color.Gray },
				{ text: this.isAutoFarming ? "Auto Farm: ON" : "Auto Farm: OFF", size: 13, weight: this.isAutoFarming ? 700 : 400, color: this.isAutoFarming ? Color.Green : Color.Gray },
				{ text: `L=${this.useLaser.value ? "ON" : "OFF"} M=${this.useMarch.value ? "ON" : "OFF"} T=${this.useTurrets.value ? "ON" : "OFF"} W=${this.useWarpFlare.value ? "ON" : "OFF"}`, size: 11, weight: 400, color: Color.LightGray },
			]
			this.drawPanel(this.statusHudPos, { val: this.isDraggingStatus }, statusLines)
		}

		if (this.showDebugHud.value && debugSpellInfo.length > 0) {
			const debugLines = debugSpellInfo.map(info => ({
				text: info, size: 11, weight: 400 as number, color: Color.White
			}))
			this.drawPanel(this.debugHudPos, { val: this.isDraggingDebug }, debugLines)
		}
	}

	// --- Main Loop ---

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) return

		const hero = LocalPlayer!.Hero!
		if (!hero.IsAlive) return

		// Diagnostic: refresh spell info setiap 60 frame
		spellInfoFrameCount++
		if (spellInfoFrameCount % 60 === 0) {
			debugSpellInfo.length = 0
			debugSpellInfo.push("--- SPELLS (live) ---")
			for (const s of hero.Spells) {
				if (s && s.IsValid && !s.IsHidden) {
					const hasNoTarget = s.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
					const hasTarget = s.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
					const hasPoint = s.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
					const behavior = hasNoTarget ? "NOTARG" : hasTarget ? "TARGET" : hasPoint ? "POINT" : "?"
					debugSpellInfo.push(`${s.Name} L${s.Level} CD=${s.Cooldown.toFixed(1)} MC=${s.ManaCost} ${behavior}`)
				}
			}
			const wg = hero.GetAbilityByName("tinker_warp_grenade")
			if (wg && wg.IsValid) {
				debugSpellInfo.push(`WARP: h=${wg.IsHidden} MC=${wg.ManaCost}`)
			}
			debugSpellInfo.push(`HasShard: ${hero.HasShard} Mana: ${hero.Mana.toFixed(0)}/${hero.MaxMana}`)
		}

		if (!this.comboEnabled.value) return

		if (this.handleBlinkKey(hero)) return
		if (this.handleSpamMarch(hero)) return

		this.handleAutoFarmToggle()
		if (this.handleAutoFarm(hero)) return

		// @ts-ignore
		if (!this.comboKey.isPressed) return

		if (hero.IsStunned || hero.IsHexed || hero.IsSilenced) return

		const bestTarget = this.findBestTarget(hero)
		if (!bestTarget) return

		const distToTarget = hero.Distance2D(bestTarget)
		if (hero.IsChanneling || this.sleeper.Sleeping) return

		if (distToTarget > 800) {
			if (this.doBlink(hero, bestTarget.Position)) return
		}

		const isImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// --- Items ---
		if (!isImmune) {
			if (this.itemsSelector.IsEnabled("item_sheepstick") && distToTarget <= 850) {
				const hex = this.tryCastItem(hero, "item_sheepstick", bestTarget)
				if (hex) { this.sleeper.Sleep(GameState.InputLag * 1000 + hex.CastPoint * 1000 + 100); return }
			}
			if (this.itemsSelector.IsEnabled("item_ethereal_blade") && distToTarget <= 850) {
				const eth = this.tryCastItem(hero, "item_ethereal_blade", bestTarget)
				if (eth) { this.sleeper.Sleep(GameState.InputLag * 1000 + eth.CastPoint * 1000 + 100); return }
			}
			if (this.itemsSelector.IsEnabled("item_dagon")) {
				const dagon = this.getDagonItem(hero)
				if (dagon && dagon.IsValid && dagon.CanBeUsable && hero.Mana >= dagon.ManaCost && dagon.Cooldown <= 0.1) {
					const r = dagon.CastRange > 0 ? dagon.CastRange : 800
					if (distToTarget <= r) { this.castTarget(hero, dagon, bestTarget); this.sleeper.Sleep(GameState.InputLag * 1000 + dagon.CastPoint * 1000 + 100); return }
				}
			}
		}
		if (this.itemsSelector.IsEnabled("item_shivas_guard") && distToTarget <= 900) {
			const sh = this.tryCastItemNoTarget(hero, "item_shivas_guard")
			if (sh) { this.sleeper.Sleep(GameState.InputLag * 1000 + sh.CastPoint * 1000 + 100); return }
		}

		// --- Spell Combo ---
		for (const spellName of COMBO_SPELLS) {
			// Check manual toggle
			switch (spellName) {
				case "tinker_laser": if (!this.useLaser.value) continue; break
				case "tinker_march_of_the_machines": if (!this.useMarch.value) continue; break
				case "tinker_deploy_turrets": if (!this.useTurrets.value) continue; break
				case "tinker_warp_grenade": if (!this.useWarpFlare.value) continue; break
			}

			const ability = hero.GetAbilityByName(spellName)
			if (!ability || !ability.IsValid || ability.IsHidden) continue
			if (ability.Cooldown > 0.1) continue
			if (hero.Mana < ability.ManaCost) continue

			switch (spellName) {
				case "tinker_laser": {
					if (isImmune) continue
					if (distToTarget > 650) continue
					this.castTarget(hero, ability, bestTarget)
					this.sleepAfterCast(ability)
					return
				}
				case "tinker_march_of_the_machines": {
					this.castPosition(hero, ability, this.groundCastPos(hero, ability, bestTarget.Position))
					this.sleepAfterCast(ability)
					return
				}
				case "tinker_deploy_turrets": {
					this.castPosition(hero, ability, this.groundCastPos(hero, ability, bestTarget.Position))
					this.sleepAfterCast(ability)
					return
				}
				case "tinker_warp_grenade": {
					if (!this.hasWarpGrenade(hero)) continue
					if (isImmune) continue
					if (distToTarget > 650) continue
					this.castTarget(hero, ability, bestTarget)
					this.sleepAfterCast(ability)
					return
				}
				case "tinker_rearm": {
					if (!this.shouldRearm(hero)) continue
					this.castNoTarget(hero, ability)
					const channelTime = ability.CastPoint > 0 ? ability.CastPoint : 0.75
					this.sleeper.Sleep(GameState.InputLag * 1000 + channelTime * 1000 + 200)
					if (this.itemsSelector.IsEnabled("item_bottle") && hero.Mana < hero.MaxMana * 0.7) {
						const bottle = hero.Items.find(i => i.Name === "item_bottle")
						if (bottle && bottle.IsValid && bottle.CanBeUsable && !hero.IsMuted && bottle.Cooldown <= 0.1) {
							this.castNoTarget(hero, bottle)
						}
					}
					return
				}
			}
		}

		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
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

import {
	Ability,
	Color,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	GUIInfo,
	Hero,
	ImageData,
	InputEventSDK,
	InputManager,
	Item,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	Rectangle,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3,
	VKeys,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const NATIVE_SPELLS = [
	"rubick_telekinesis",
	"rubick_telekinesis_land",
	"rubick_telekinesis_land_self",
	"rubick_fade_bolt",
	"rubick_empty1",
	"rubick_empty2",
	"rubick_spell_steal",
	"rubick_hidden1",
	"rubick_hidden2",
	"rubick_hidden3",
	"rubick_arcane_supremacy",
	"rubick_might_and_magus",
	"generic_hidden",
	"attribute_bonus"
]

const COMBO_ITEMS = [
	"item_blink",
	"item_sheepstick",
	"item_orchid",
	"item_bloodthorn",
	"item_nullifier",
	"item_rod_of_atos",
	"item_ethereal_blade",
	"item_veil_of_discord",
	"item_shivas_guard",
	"item_dagon",
	"item_black_king_bar"
]

new (class RubickCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Rubick Combo", "panorama/images/heroes/icons/npc_dota_hero_rubick_png.vtex_c", "", 0)

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Rubick combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto a single target hero when holding the combo key"
	)

	private readonly itemsNode = this.entry.AddNode("Items Integration")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Use Items",
		COMBO_ITEMS,
		new Map([
			["item_blink", true],
			["item_sheepstick", true],
			["item_orchid", true],
			["item_bloodthorn", true],
			["item_nullifier", true],
			["item_rod_of_atos", true],
			["item_ethereal_blade", true],
			["item_veil_of_discord", true],
			["item_shivas_guard", true],
			["item_dagon", true],
			["item_black_king_bar", true]
		]),
		"Enable or disable items for Rubick combo"
	)

	private readonly blinkMode = this.itemsNode.AddDropdown(
		"Blink Dagger Usage",
		["Blink Directly to Target", "Blink Max Range Towards Target", "Disabled"],
		0,
		"How Blink Dagger initiates on the target"
	)

	private readonly telekinesisNode = this.entry.AddNode("Telekinesis Land Options")
	private readonly telekinesisLandMode = this.telekinesisNode.AddDropdown(
		"Telekinesis Land Direction",
		["Pull Towards Rubick / Allies", "Throw Towards Nearest Enemy (AoE Stun)", "Towards Cursor", "Disabled"],
		0,
		"Where to drop the lifted enemy with Telekinesis Land"
	)

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
		0,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break on some heroes"
	)

	private readonly autoStealNode = this.entry.AddNode("Auto Steal Spells (Background)")
	private readonly autoStealEnabled = this.autoStealNode.AddToggle("Enabled", true)
	private autoStealGrid: any

	private readonly autoStealHudNode = this.autoStealNode.AddNode("Floating HUD Panel")
	private readonly autoStealHudEnabled = this.autoStealHudNode.AddToggle("Show HUD Panel", true)
	private readonly autoStealHudKey = this.autoStealHudNode.AddKeybind(
		"Toggle HUD Key",
		"None",
		"Key to toggle HUD panel visibility"
	)
	private readonly autoStealHudX = this.autoStealHudNode.AddSlider("HUD Position X", 400, 0, 2500)
	private readonly autoStealHudY = this.autoStealHudNode.AddSlider("HUD Position Y", 200, 0, 2500)
	private readonly autoStealHudIconSize = this.autoStealHudNode.AddSlider("HUD Icon Size", 36, 20, 80)

	private readonly autoCastNode = this.entry.AddNode("Stolen Spells Auto-Cast")
	private autoCastGrid: any

	private readonly hudOffsetNode = this.entry.AddNode("HUD Adjustments (Resolution Fix)")
	private readonly hudOffsetX = this.hudOffsetNode.AddSlider("X Offset", 0, -100, 100)
	private readonly hudOffsetY = this.hudOffsetNode.AddSlider("Y Offset", 0, -100, 100)
	private readonly hudSizeW = this.hudOffsetNode.AddSlider("Width Offset", 0, -50, 50)
	private readonly hudSizeH = this.hudOffsetNode.AddSlider("Height Offset", 0, -50, 50)

	private comboSequenceGrid: any

	private readonly sleeper = new TickSleeper()
	private readonly stealSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	private isDraggingHud = false
	private dragOffsetX = 0
	private dragOffsetY = 0
	private dragSpellName: string | undefined = undefined
	private firstFrameCleanup = true
	private lockedTarget: Hero | undefined = undefined

	constructor() {
		this.autoStealGrid = this.autoStealNode.AddDynamicImageSelector("Spells", [], new Map())
		this.autoCastGrid = this.autoCastNode.AddDynamicImageSelector("Spells", [], new Map())

		this.autoStealGrid.enabledValues.clear()
		this.autoStealGrid.values.length = 0
		this.autoStealGrid.Update()
		this.autoCastGrid.enabledValues.clear()
		this.autoCastGrid.values.length = 0
		this.autoCastGrid.Update()

		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("rubick_telekinesis", [true, true, true, 0])
		defaultCombo.set("rubick_fade_bolt", [true, true, true, 1])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Skill Order",
			["rubick_telekinesis", "rubick_fade_bolt"],
			defaultCombo
		)

		this.autoStealHudKey.OnPressed(() => {
			this.autoStealHudEnabled.value = !this.autoStealHudEnabled.value
			Menu.Base.SaveConfigASAP = true
		})

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("AbilityCooldownChanged", this.AbilityCooldownChanged.bind(this))
		InputEventSDK.on("MouseKeyDown", this.OnMouseKeyDown.bind(this))
		InputEventSDK.on("MouseKeyUp", this.OnMouseKeyUp.bind(this))
		EventsSDK.on("Draw", this.OnDraw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.stealSleeper.Sleep(0)
		this.isDraggingHud = false
		this.dragSpellName = undefined
		this.firstFrameCleanup = true
		this.lockedTarget = undefined
		this.pSDK.DestroyAll()

		if (this.autoStealGrid) {
			this.autoStealGrid.enabledValues.clear()
			this.autoStealGrid.values.length = 0
			this.autoStealGrid.Update()
		}
		if (this.autoCastGrid) {
			this.autoCastGrid.enabledValues.clear()
			this.autoCastGrid.values.length = 0
			this.autoCastGrid.Update()
		}
		if (this.comboSequenceGrid) {
			this.comboSequenceGrid.ResetToDefault()
		}
	}

	private getSortedAutoStealSpells(): string[] {
		if (!this.autoStealGrid) {
			return []
		}
		const entries = [...this.autoStealGrid.enabledValues.entries()] as [
			string,
			[boolean, boolean, boolean, number]
		][]
		entries.sort((a, b) => a[1][3] - b[1][3])
		return entries.map(e => e[0])
	}

	private IsAbilityVisibleOnHUD(abil: Ability | undefined): abil is Ability {
		return abil !== undefined && abil.IsValid && !abil.IsHidden && abil.ShouldBeDrawable
	}

	private getAdjustedRect(rect: Rectangle): Rectangle {
		const adjusted = rect.Clone()
		const ox = this.hudOffsetX.value
		const oy = this.hudOffsetY.value
		const ow = this.hudSizeW.value
		const oh = this.hudSizeH.value

		adjusted.pos1.x += ox
		adjusted.pos1.y += oy
		adjusted.pos2.x += ox + ow
		adjusted.pos2.y += oy + oh

		return adjusted
	}

	private getItem(hero: Hero, baseName: string): Item | undefined {
		for (const item of hero.Items) {
			if (item && item.IsValid && item.Name.startsWith(baseName)) {
				return item
			}
		}
		return undefined
	}

	private executeTelekinesisLand(hero: Hero, target: Hero): boolean {
		const landAbil = hero.GetAbilityByName("rubick_telekinesis_land")
		if (!landAbil || !landAbil.IsValid || landAbil.IsHidden || landAbil.Level <= 0 || landAbil.Cooldown > 0.1) {
			return false
		}

		const mode = this.telekinesisLandMode.SelectedID
		if (mode === 3) {
			return false
		}

		let landPos: Vector3 | undefined

		if (mode === 0) {
			// Pull towards Rubick / Allies
			const dir = hero.Position.Subtract(target.Position).Normalize()
			landPos = target.Position.Add(dir.MultiplyScalar(350))
		} else if (mode === 1) {
			// Throw towards nearest other enemy for AoE secondary stun
			let nearestOtherEnemy: Hero | undefined
			let minDist = Infinity
			for (const other of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					other.IsValid &&
					other.IsAlive &&
					other.IsVisible &&
					other.IsEnemy(hero) &&
					other !== target &&
					!other.IsIllusion
				) {
					const dist = target.Distance2D(other)
					if (dist < 600 && dist < minDist) {
						minDist = dist
						nearestOtherEnemy = other
					}
				}
			}
			if (nearestOtherEnemy) {
				const dir = nearestOtherEnemy.Position.Subtract(target.Position).Normalize()
				landPos = target.Position.Add(dir.MultiplyScalar(Math.min(350, target.Distance2D(nearestOtherEnemy))))
			} else {
				const dir = hero.Position.Subtract(target.Position).Normalize()
				landPos = target.Position.Add(dir.MultiplyScalar(350))
			}
		} else if (mode === 2) {
			// Towards Cursor
			const mousePos = InputManager.CursorOnWorld
			const dir = mousePos.Subtract(target.Position).Normalize()
			landPos = target.Position.Add(dir.MultiplyScalar(350))
		}

		if (landPos) {
			claimOrder()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
				issuers: [hero],
				position: landPos,
				ability: landAbil.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return true
		}

		return false
	}

	private executeItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		// 1. BLINK DAGGER
		if (this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2) {
			const blink =
				this.getItem(hero, "item_blink") ||
				this.getItem(hero, "item_arcane_blink") ||
				this.getItem(hero, "item_swift_blink") ||
				this.getItem(hero, "item_overwhelming_blink")

			if (blink && blink.Cooldown <= 0.1) {
				const dist = hero.Distance2D(bestTarget)
				if (dist > 400 && dist <= 1200) {
					let blinkPos = bestTarget.Position.Clone()
					if (this.blinkMode.SelectedID === 1) {
						const dir = bestTarget.Position.Subtract(hero.Position).Normalize()
						blinkPos = hero.Position.Add(dir.MultiplyScalar(1150))
					}

					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: blinkPos,
						ability: blink.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
					return true
				}
			}
		}

		// 2. BLACK KING BAR
		if (this.itemsSelector.IsEnabled("item_black_king_bar")) {
			const bkb = this.getItem(hero, "item_black_king_bar")
			if (bkb && bkb.Cooldown <= 0.1 && hero.Distance2D(bestTarget) <= 800) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bkb.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 3. SCYTHE OF VYSE (HEX)
		if (this.itemsSelector.IsEnabled("item_sheepstick") && !isTargetImmune) {
			const hex = this.getItem(hero, "item_sheepstick")
			if (hex && hex.Cooldown <= 0.1 && hero.Mana >= hex.ManaCost && hero.Distance2D(bestTarget) <= 800) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: hex.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 4. ORCHID / BLOODTHORN
		if (
			(this.itemsSelector.IsEnabled("item_orchid") || this.itemsSelector.IsEnabled("item_bloodthorn")) &&
			!isTargetImmune
		) {
			const silence = this.getItem(hero, "item_bloodthorn") || this.getItem(hero, "item_orchid")
			if (
				silence &&
				silence.Cooldown <= 0.1 &&
				hero.Mana >= silence.ManaCost &&
				hero.Distance2D(bestTarget) <= 900
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: silence.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 5. NULLIFIER
		if (this.itemsSelector.IsEnabled("item_nullifier") && !isTargetImmune) {
			const nullifier = this.getItem(hero, "item_nullifier")
			if (
				nullifier &&
				nullifier.Cooldown <= 0.1 &&
				hero.Mana >= nullifier.ManaCost &&
				hero.Distance2D(bestTarget) <= 900
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: nullifier.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 6. ROD OF ATOS / GLEIPNIR
		if (this.itemsSelector.IsEnabled("item_rod_of_atos") && !isTargetImmune) {
			const atos = this.getItem(hero, "item_gungir") || this.getItem(hero, "item_rod_of_atos")
			if (atos && atos.Cooldown <= 0.1 && hero.Mana >= atos.ManaCost && hero.Distance2D(bestTarget) <= 1100) {
				claimOrder()
				if (atos.Name === "item_gungir") {
					const castPos = bestTarget.Position.Clone()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: atos.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: atos.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 7. ETHEREAL BLADE
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !isTargetImmune) {
			const eblade = this.getItem(hero, "item_ethereal_blade")
			if (
				eblade &&
				eblade.Cooldown <= 0.1 &&
				hero.Mana >= eblade.ManaCost &&
				hero.Distance2D(bestTarget) <= 800
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: eblade.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 8. VEIL OF DISCORD
		if (this.itemsSelector.IsEnabled("item_veil_of_discord") && !isTargetImmune) {
			const veil = this.getItem(hero, "item_veil_of_discord")
			if (veil && veil.Cooldown <= 0.1 && hero.Mana >= veil.ManaCost && hero.Distance2D(bestTarget) <= 1000) {
				const castPos = bestTarget.Position.Clone()
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: castPos,
					ability: veil.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 9. SHIVA'S GUARD
		if (this.itemsSelector.IsEnabled("item_shivas_guard") && !isTargetImmune) {
			const shiva = this.getItem(hero, "item_shivas_guard")
			if (shiva && shiva.Cooldown <= 0.1 && hero.Mana >= shiva.ManaCost && hero.Distance2D(bestTarget) <= 900) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: shiva.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 10. DAGON
		if (this.itemsSelector.IsEnabled("item_dagon") && !isTargetImmune) {
			const dagon = this.getItem(hero, "item_dagon")
			if (dagon && dagon.Cooldown <= 0.1 && hero.Mana >= dagon.ManaCost && hero.Distance2D(bestTarget) <= 800) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: dagon.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		return false
	}

	private executeStolenSpells(
		stolenSpells: Ability[],
		hero: Hero,
		bestTarget: Hero,
		isTargetImmune: boolean
	): boolean {
		for (const stolenSpell of stolenSpells) {
			if (
				stolenSpell &&
				stolenSpell.IsValid &&
				stolenSpell.Cooldown <= 0.1 &&
				hero.Mana >= stolenSpell.ManaCost &&
				!isTargetImmune
			) {
				if (!this.autoCastGrid) {
					return false
				}
				if (this.autoCastGrid.IsEnabled(stolenSpell.Name)) {
					const isTarget = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
					const isPosition = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
					const isNoTarget = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)

					const castRange = stolenSpell.CastRange > 0 ? stolenSpell.CastRange : 600

					if (isNoTarget && hero.Distance2D(bestTarget) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					} else if (isPosition && hero.Distance2D(bestTarget) <= castRange) {
						const castPos = bestTarget.Position.Clone()

						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: castPos,
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					} else if (isTarget && hero.Distance2D(bestTarget) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					}
				}
			}
		}
		return false
	}

	private OnDraw(): void {
		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.autoStealGrid || !this.autoCastGrid || !this.comboSequenceGrid) {
			return
		}

		// ------------------ FLOATING HUD PANEL DRAGGING ------------------
		if (this.autoStealHudEnabled.value && this.isDraggingHud) {
			const cursorPos = InputManager.CursorOnScreen
			const newX = cursorPos.x - this.dragOffsetX
			const newY = cursorPos.y - this.dragOffsetY

			this.autoStealHudX.value = Math.max(0, Math.round(newX))
			this.autoStealHudY.value = Math.max(0, Math.round(newY))
		}

		const hud = GUIInfo.GetLowerHUDForUnit(hero)
		if (hud && hud.AbilitiesRects) {
			let visibleIndex = 0
			for (const abil of hero.Spells) {
				if (this.IsAbilityVisibleOnHUD(abil)) {
					if (
						this.autoCastGrid &&
						this.autoCastGrid.values.includes(abil.Name) &&
						this.autoCastGrid.IsEnabled(abil.Name)
					) {
						if (visibleIndex < hud.AbilitiesRects.length) {
							const rect = this.getAdjustedRect(hud.AbilitiesRects[visibleIndex])

							const insetRect = rect.Clone()
							insetRect.pos1.x += 2
							insetRect.pos1.y += 2
							insetRect.pos2.x -= 2
							insetRect.pos2.y -= 2

							RendererSDK.OutlinedRect(insetRect.pos1, insetRect.Size, 2, Color.Green)

							const fontName = "PTSans"
							const fontSize = 11
							const fontWeight = 800
							const text = "AUTO"
							const textSize = RendererSDK.GetTextSize(text, fontName, fontSize, fontWeight, false)

							const textX = rect.pos1.x + (rect.Width - textSize.x) / 2
							const textY = rect.pos2.y - textSize.y - 4
							const textPos = new Vector2(textX, textY)

							const bgPaddingX = 4
							const bgPaddingY = 1
							const bgPos = new Vector2(textX - bgPaddingX, textY - bgPaddingY)
							const bgSize = new Vector2(textSize.x + bgPaddingX * 2, textSize.y + bgPaddingY * 2)
							RendererSDK.FilledRect(bgPos, bgSize, Color.Black.SetA(180))

							RendererSDK.Text(text, textPos, Color.Green, fontName, fontSize, fontWeight, false, true)
						}
					}

					if (abil.Name === "kez_switch_weapons") {
						visibleIndex += 2
					} else {
						visibleIndex++
					}
				}
			}
		}

		// ------------------ FLOATING HUD PANEL ------------------
		if (this.autoStealHudEnabled.value) {
			if (!this.autoStealGrid) {
				return
			}
			const values = this.getSortedAutoStealSpells()
			const iconSize = this.autoStealHudIconSize.value
			const gap = 6
			const cols = 5

			const N = values.length

			const panelX = this.autoStealHudX.value
			const panelY = this.autoStealHudY.value

			const rows = Math.max(1, Math.ceil(N / cols))
			const panelWidth = Math.max(150, Math.min(N > 0 ? N : cols, cols) * (iconSize + gap) + gap)
			const headerHeight = 22
			const panelHeight = headerHeight + rows * (iconSize + gap) + gap

			const panelPos = new Vector2(panelX, panelY)
			const panelSize = new Vector2(panelWidth, panelHeight)

			RendererSDK.FilledRect(panelPos, panelSize, Color.Black.SetA(160))
			RendererSDK.OutlinedRect(panelPos, panelSize, 1, Color.White.SetA(60))

			const headerRectSize = new Vector2(panelWidth, headerHeight)
			RendererSDK.FilledRect(panelPos, headerRectSize, Color.Black.SetA(200))
			RendererSDK.OutlinedRect(panelPos, headerRectSize, 1, Color.White.SetA(60))

			const fontName = "PTSans"
			const fontSize = 11
			const fontWeight = 800
			const titleText = "AUTO STEAL PANEL"
			const titleTextSize = RendererSDK.GetTextSize(titleText, fontName, fontSize, fontWeight, false)
			const titleX = panelX + (panelWidth - titleTextSize.x) / 2
			const titleY = panelY + (headerHeight - titleTextSize.y) / 2
			RendererSDK.Text(
				titleText,
				new Vector2(titleX, titleY),
				Color.White,
				fontName,
				fontSize,
				fontWeight,
				false,
				true
			)

			if (N === 0) {
				const noSpellsText = "No enemy spells detected"
				const noSpellsSize = RendererSDK.GetTextSize(noSpellsText, fontName, 10, 400, false)
				const nsX = panelX + (panelWidth - noSpellsSize.x) / 2
				const nsY = panelY + headerHeight + (panelHeight - headerHeight - noSpellsSize.y) / 2
				RendererSDK.Text(noSpellsText, new Vector2(nsX, nsY), Color.Gray, fontName, 10, 400, false, true)
			} else {
				for (let i = 0; i < N; i++) {
					const spellName = values[i]
					const col = i % cols
					const row = Math.floor(i / cols)

					const iconX = panelX + gap + col * (iconSize + gap)
					const iconY = panelY + headerHeight + gap + row * (iconSize + gap)
					const iconPos = new Vector2(iconX, iconY)
					const iconRectSize = new Vector2(iconSize, iconSize)

					const path = ImageData.GetSpellTexture(spellName)
					const isEnabled = this.autoStealGrid.IsEnabled(spellName)

					RendererSDK.Image(path, iconPos, -1, iconRectSize, Color.White, 0, undefined, !isEnabled)

					if (isEnabled) {
						RendererSDK.OutlinedRect(iconPos, iconRectSize, 2, Color.Green)
					} else {
						RendererSDK.OutlinedRect(iconPos, iconRectSize, 1, Color.Red.SetA(180))
					}

					const prioText = `${i + 1}`
					const prioSize = RendererSDK.GetTextSize(prioText, fontName, 9, 800, false)
					const badgePaddingX = 3
					const badgePaddingY = 1

					const badgePos = new Vector2(iconX + 2, iconY + 2)
					const badgeSize = new Vector2(prioSize.x + badgePaddingX * 2, prioSize.y + badgePaddingY * 2)

					RendererSDK.FilledRect(badgePos, badgeSize, Color.Black.SetA(200))
					RendererSDK.OutlinedRect(
						badgePos,
						badgeSize,
						1,
						isEnabled ? Color.Green.SetA(150) : Color.Red.SetA(150)
					)
					RendererSDK.Text(
						prioText,
						new Vector2(badgePos.x + badgePaddingX, badgePos.y + badgePaddingY),
						Color.White,
						fontName,
						9,
						800,
						false,
						true
					)
				}
			}
		}

		// ------------------ FLOATING HUD PANEL DRAGGING SPELL ICON ------------------
		if (this.autoStealHudEnabled.value && this.dragSpellName !== undefined) {
			const cursorPos = InputManager.CursorOnScreen
			const iconSize = this.autoStealHudIconSize.value
			const path = ImageData.GetSpellTexture(this.dragSpellName)
			const dragIconPos = cursorPos.Subtract(new Vector2(iconSize / 2, iconSize / 2))
			const dragIconSize = new Vector2(iconSize, iconSize)

			RendererSDK.Image(path, dragIconPos, -1, dragIconSize, Color.White, 0, undefined, false)
			RendererSDK.OutlinedRect(dragIconPos, dragIconSize, 2, Color.Yellow)
		}
	}

	private OnMouseKeyDown(key: VMouseKeys): boolean | void {
		if (key !== VMouseKeys.MK_LBUTTON) {
			return
		}

		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero) {
			return
		}

		const cursorPos = InputManager.CursorOnScreen

		if (this.autoStealHudEnabled.value) {
			if (!this.autoStealGrid) {
				return
			}
			const values = this.getSortedAutoStealSpells()
			const iconSize = this.autoStealHudIconSize.value
			const gap = 6
			const cols = 5

			const N = values.length
			const panelX = this.autoStealHudX.value
			const panelY = this.autoStealHudY.value

			const rows = Math.max(1, Math.ceil(N / cols))
			const panelWidth = Math.max(150, Math.min(N > 0 ? N : cols, cols) * (iconSize + gap) + gap)
			const headerHeight = 22
			const panelHeight = headerHeight + rows * (iconSize + gap) + gap

			const panelRect = new Rectangle(
				new Vector2(panelX, panelY),
				new Vector2(panelX + panelWidth, panelY + panelHeight)
			)

			if (panelRect.Contains(cursorPos)) {
				const headerRect = new Rectangle(
					new Vector2(panelX, panelY),
					new Vector2(panelX + panelWidth, panelY + headerHeight)
				)

				if (headerRect.Contains(cursorPos)) {
					this.isDraggingHud = true
					this.dragOffsetX = cursorPos.x - panelX
					this.dragOffsetY = cursorPos.y - panelY
					return true
				}

				const isCtrlHeld = InputManager.IsKeyDown(VKeys.CONTROL)
				for (let i = 0; i < N; i++) {
					const spellName = values[i]
					const col = i % cols
					const row = Math.floor(i / cols)

					const iconX = panelX + gap + col * (iconSize + gap)
					const iconY = panelY + headerHeight + gap + row * (iconSize + gap)

					const iconRect = new Rectangle(
						new Vector2(iconX, iconY),
						new Vector2(iconX + iconSize, iconY + iconSize)
					)

					if (iconRect.Contains(cursorPos)) {
						if (isCtrlHeld) {
							this.dragSpellName = spellName
						} else if (this.autoStealGrid) {
							const enabledValues = this.autoStealGrid.enabledValues.get(spellName)
							if (enabledValues) {
								enabledValues[0] = !enabledValues[0]
								this.autoStealGrid.Update()
								Menu.Base.SaveConfigASAP = true
							}
						}
						break
					}
				}
				return true
			}
		}

		if (!InputManager.IsKeyDown(16)) {
			return
		}

		const hud = GUIInfo.GetLowerHUDForUnit(hero)
		if (!hud || !hud.AbilitiesRects) {
			return
		}

		let clickedIndex = -1
		for (let i = 0; i < hud.AbilitiesRects.length; i++) {
			const adjustedRect = this.getAdjustedRect(hud.AbilitiesRects[i])
			if (adjustedRect.Contains(cursorPos)) {
				clickedIndex = i
				break
			}
		}

		if (clickedIndex !== -1) {
			let visibleIndex = 0
			for (const abil of hero.Spells) {
				if (this.IsAbilityVisibleOnHUD(abil)) {
					if (visibleIndex === clickedIndex) {
						if (this.autoCastGrid && this.autoCastGrid.values.includes(abil.Name)) {
							const enabledValues = this.autoCastGrid.enabledValues.get(abil.Name)
							if (enabledValues) {
								enabledValues[0] = !enabledValues[0]
								Menu.Base.SaveConfigASAP = true
							}
						}
						return true
					}

					if (abil.Name === "kez_switch_weapons") {
						visibleIndex += 2
					} else {
						visibleIndex++
					}
				}
			}
		}
	}

	private OnMouseKeyUp(key: VMouseKeys): boolean | void {
		if (key === VMouseKeys.MK_LBUTTON) {
			if (this.isDraggingHud) {
				this.isDraggingHud = false
				Menu.Base.SaveConfigASAP = true
				return true
			}

			if (this.dragSpellName !== undefined) {
				const dragSpellName = this.dragSpellName
				this.dragSpellName = undefined

				if (this.autoStealHudEnabled.value) {
					if (!this.autoStealGrid) {
						return true
					}

					const values = this.getSortedAutoStealSpells()
					const iconSize = this.autoStealHudIconSize.value
					const gap = 6
					const cols = 5

					const N = values.length
					const panelX = this.autoStealHudX.value
					const panelY = this.autoStealHudY.value
					const headerHeight = 22

					const cursorPos = InputManager.CursorOnScreen

					let targetSpellName: string | undefined
					for (let i = 0; i < N; i++) {
						const col = i % cols
						const row = Math.floor(i / cols)

						const iconX = panelX + gap + col * (iconSize + gap)
						const iconY = panelY + headerHeight + gap + row * (iconSize + gap)

						const iconRect = new Rectangle(
							new Vector2(iconX, iconY),
							new Vector2(iconX + iconSize, iconY + iconSize)
						)

						if (iconRect.Contains(cursorPos)) {
							targetSpellName = values[i]
							break
						}
					}

					if (targetSpellName !== undefined && targetSpellName !== dragSpellName) {
						const entries = [...this.autoStealGrid.enabledValues.entries()] as [
							string,
							[boolean, boolean, boolean, number]
						][]
						entries.sort((a, b) => a[1][3] - b[1][3])

						const dragIdx = entries.findIndex(e => e[0] === dragSpellName)
						const targetIdx = entries.findIndex(e => e[0] === targetSpellName)

						if (dragIdx !== -1 && targetIdx !== -1) {
							const [dragged] = entries.splice(dragIdx, 1)
							entries.splice(targetIdx, 0, dragged)

							for (let k = 0; k < entries.length; k++) {
								entries[k][1][3] = k
							}

							this.autoStealGrid.values = entries.map(e => e[0])
							this.autoStealGrid.Update()
							Menu.Base.SaveConfigASAP = true
						}
					}
				}
				return true
			}
		}
	}

	private get hasLocalHero(): boolean {
		return Boolean(
			LocalPlayer &&
				LocalPlayer.Hero &&
				LocalPlayer.Hero.IsValid &&
				LocalPlayer.Hero.Name === "npc_dota_hero_rubick"
		)
	}

	private isValidSpell(abil: Ability | undefined): abil is Ability {
		if (!abil || !abil.IsValid || abil.IsHidden || abil.IsItem) {
			return false
		}
		const name = abil.Name
		if (NATIVE_SPELLS.includes(name)) {
			return false
		}
		if (name.startsWith("special_bonus_")) {
			return false
		}
		if (name.includes("empty")) {
			return false
		}
		if (name === "plus_high_five" || name === "twin_gate_portal_warp") {
			return false
		}

		const isPassive = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_PASSIVE)
		const isNoTarget = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
		const isTarget = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
		const isPosition = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
		const isToggle = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_TOGGLE)
		const isAutoCast = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_AUTOCAST)

		if (isPassive && !isNoTarget && !isTarget && !isPosition && !isToggle && !isAutoCast) {
			return false
		}

		return true
	}

	private AbilityCooldownChanged(ability: Ability): void {
		if (!this.hasLocalHero || ExecuteOrder.DisableHumanizer || !this.autoStealEnabled.value) {
			return
		}

		if (!ability || !ability.IsValid || ability.IsItem || ability.Cooldown <= 1) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		const owner = ability.Owner
		if (!owner || !(owner instanceof Hero) || !owner.IsEnemy(hero) || owner.IsIllusion) {
			return
		}

		const spellName = ability.Name

		if (!this.autoStealGrid) {
			return
		}

		// 1. MUST be enabled in Auto Steal grid by the user
		if (!this.autoStealGrid.IsEnabled(spellName)) {
			return
		}

		const spellSteal = hero.GetAbilityByName("rubick_spell_steal")
		if (
			!spellSteal ||
			!spellSteal.IsValid ||
			spellSteal.Level <= 0 ||
			spellSteal.Cooldown > 0.1 ||
			hero.Mana < spellSteal.ManaCost
		) {
			return
		}

		const newSpellPriority = this.autoStealGrid.GetPriority(spellName)
		if (newSpellPriority === Number.MAX_SAFE_INTEGER) {
			return
		}

		// Collect currently held stolen spells on Rubick
		const currentStolenSpells: Ability[] = []
		for (const abil of hero.Spells) {
			if (this.isValidSpell(abil)) {
				currentStolenSpells.push(abil)
			}
		}

		// 2. Never steal if we already hold this exact spell
		for (const held of currentStolenSpells) {
			if (held.Name === spellName) {
				return
			}
		}

		// 3. Strict Priority Hierarchy:
		// Priority 0 = Rank 1 (highest priority). Smaller number = higher priority.
		const hasAghanim = hero.HasScepter

		if (!hasAghanim) {
			// Single stolen spell slot:
			if (currentStolenSpells.length > 0) {
				const currentSpell = currentStolenSpells[0]
				const currentPriority = this.autoStealGrid.GetPriority(currentSpell.Name)
				// If currently held spell is equal or higher priority than the new spell, DO NOT STEAL!
				if (currentPriority <= newSpellPriority) {
					return
				}
			}
		} else if (currentStolenSpells.length >= 2) {
			// Dual stolen spell slots (Aghanim):
			const prio1 = this.autoStealGrid.GetPriority(currentStolenSpells[0].Name)
			const prio2 = this.autoStealGrid.GetPriority(currentStolenSpells[1].Name)
			// If BOTH held spells are equal or higher priority than the new spell, DO NOT STEAL!
			if (prio1 <= newSpellPriority && prio2 <= newSpellPriority) {
				return
			}
		}

		// Execute Spell Steal
		if (!this.stealSleeper.Sleeping) {
			const castRange = spellSteal.CastRange > 0 ? spellSteal.CastRange : 1000
			if (hero.Distance2D(owner) <= castRange + 400) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: owner.Index,
					ability: spellSteal.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.stealSleeper.Sleep(Math.max(800, GameState.InputLag * 1000 + spellSteal.CastPoint * 1000 + 100))
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("rubick_target_ring")
			return
		}

		if (!this.autoStealGrid || !this.autoCastGrid || !this.comboSequenceGrid) {
			return
		}

		if (this.firstFrameCleanup) {
			this.firstFrameCleanup = false
			if (this.autoStealGrid.values.length > 0) {
				this.autoStealGrid.enabledValues.clear()
				this.autoStealGrid.values.length = 0
				this.autoStealGrid.Update()
			}
			if (this.autoCastGrid.values.length > 0) {
				this.autoCastGrid.enabledValues.clear()
				this.autoCastGrid.values.length = 0
				this.autoCastGrid.Update()
				Menu.Base.SaveConfigASAP = true
			}
		}

		const enemySpellNames = new Set<string>()
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy && enemy.IsValid && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				for (const abil of enemy.Spells) {
					if (this.isValidSpell(abil)) {
						enemySpellNames.add(abil.Name)
					}
				}
			}
		}

		const stolenSpellNames = new Set<string>()
		const stolenSpells: Ability[] = []
		for (const abil of hero.Spells) {
			if (this.isValidSpell(abil)) {
				stolenSpells.push(abil)
				stolenSpellNames.add(abil.Name)
			}
		}

		let gridDirty = false

		// Dynamically register newly discovered enemy spells without deleting existing configured ones
		for (const name of enemySpellNames) {
			if (!this.autoStealGrid.values.includes(name)) {
				this.autoStealGrid.values.push(name)
			}
			if (!this.autoStealGrid.enabledValues.has(name)) {
				this.autoStealGrid.enabledValues.set(name, [true, true, true, this.autoStealGrid.enabledValues.size])
				gridDirty = true
			}
		}

		// Update AutoCast grid with currently stolen spells
		for (const name of stolenSpellNames) {
			if (!this.autoCastGrid.values.includes(name)) {
				this.autoCastGrid.values.push(name)
			}
			if (!this.autoCastGrid.enabledValues.has(name)) {
				this.autoCastGrid.enabledValues.set(name, [true, true, true, this.autoCastGrid.enabledValues.size])
				gridDirty = true
			}
		}

		if (gridDirty) {
			this.autoStealGrid.Update()
			this.autoCastGrid.Update()
			Menu.Base.SaveConfigASAP = true
		}

		// Check if combo key is held
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("rubick_target_ring")
			return
		}

		if (hero.IsChanneling || hero.IsInvisible || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// ------------------ TARGET SELECTION & LOCKING ------------------
		let bestTarget: Hero | undefined = this.lockedTarget
		if (!bestTarget || !bestTarget.IsValid || !bestTarget.IsAlive || !bestTarget.IsVisible) {
			const mousePos = InputManager.CursorOnWorld
			let minDist = Infinity
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
					const dist = enemy.Position.Distance2D(mousePos)
					if (dist < this.comboRadius.value && dist < minDist) {
						minDist = dist
						bestTarget = enemy
					}
				}
			}
			if (this.lockTargetEnabled.value && bestTarget) {
				this.lockedTarget = bestTarget
			}
		}

		if (!bestTarget) {
			this.pSDK.DestroyByKey("rubick_target_ring")
			return
		}

		this.pSDK.DrawCircle("rubick_target_ring", bestTarget, 140, {
			Color: new Color(0, 255, 120, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune
		let stolenSpellsExecuted = false

		// ------------------ ITEMS EXECUTION ------------------
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// ------------------ TELEKINESIS LAND CHECK ------------------
		if (this.executeTelekinesisLand(hero, bestTarget)) {
			return
		}

		// ------------------ SKILL ORDER EXECUTION ------------------
		for (const actionName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(actionName)) {
				continue
			}

			// 1. TELEKINESIS
			if (actionName === "rubick_telekinesis") {
				const telekinesis = hero.GetAbilityByName("rubick_telekinesis")
				if (
					telekinesis &&
					telekinesis.IsValid &&
					telekinesis.Level > 0 &&
					telekinesis.Cooldown <= 0.1 &&
					hero.Mana >= telekinesis.ManaCost &&
					!isTargetImmune
				) {
					const castRange = telekinesis.CastRange > 0 ? telekinesis.CastRange : 600
					if (hero.Distance2D(bestTarget) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: telekinesis.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + telekinesis.CastPoint * 1000 + 100)
						return
					}
				}

				if (!stolenSpellsExecuted) {
					stolenSpellsExecuted = true
					if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
						return
					}
				}
			}

			// 2. FADE BOLT
			else if (actionName === "rubick_fade_bolt") {
				if (!stolenSpellsExecuted) {
					stolenSpellsExecuted = true
					if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
						return
					}
				}

				const fadeBolt = hero.GetAbilityByName("rubick_fade_bolt")
				if (
					fadeBolt &&
					fadeBolt.IsValid &&
					fadeBolt.Level > 0 &&
					fadeBolt.Cooldown <= 0.1 &&
					hero.Mana >= fadeBolt.ManaCost &&
					!isTargetImmune
				) {
					const castRange = fadeBolt.CastRange > 0 ? fadeBolt.CastRange : 800
					if (hero.Distance2D(bestTarget) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: fadeBolt.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + fadeBolt.CastPoint * 1000 + 100)
						return
					}
				}
			}
		}

		// Fallback for stolen spells
		if (!stolenSpellsExecuted) {
			stolenSpellsExecuted = true
			if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
				return
			}
		}

		// Fallback: Orb Walk
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()

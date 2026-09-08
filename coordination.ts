import { EventsSDK } from "github.com/octarine-public/wrapper/index"

let orderIssuedThisFrame = false

// Reset the flag at the start of every PostDataUpdate frame.
// This handler is registered first (due to import order in index.ts),
// so it executes before all other PostDataUpdate handlers.
EventsSDK.on("PostDataUpdate", () => {
	orderIssuedThisFrame = false
})
EventsSDK.on("GameEnded", () => {
	orderIssuedThisFrame = false
})
EventsSDK.on("GameStarted", () => {
	orderIssuedThisFrame = false
})

/** Peek at whether any script has already issued an order this frame. */
export function hasOrderBeenIssued(): boolean {
	return orderIssuedThisFrame
}

/** Claim the order slot for this frame — subsequent scripts should skip. */
export function claimOrder(): void {
	orderIssuedThisFrame = true
}

/**
 * Bulletproof helper to determine if a hero entity is a REAL hero,
 * filtering out illusions from Phantom Lancer, Chaos Knight, Manta, Runes, etc.
 */
export function isRealHero(hero: any): boolean {
	if (!hero || !hero.IsValid || !hero.IsAlive) {
		return false
	}
	if (hero.IsIllusion) {
		return false
	}
	if (hero.Name === "npc_dota_hero_phantom_lancer") {
		return !hero.Buffs.some(
			(b: any) =>
				b &&
				b.IsValid &&
				(b.Name === "modifier_phantom_lancer_juxtapose_illusion" ||
					b.Name === "modifier_phantom_lancer_juxtapose_illusion_uncontrollable" ||
					b.Name === "modifier_phantom_lancer_doppelwalk_illusion" ||
					b.Name === "modifier_illusion")
		)
	}
	return true
}

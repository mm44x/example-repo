import { EventsSDK } from "github.com/octarine-public/wrapper/index"

let orderIssuedThisFrame = false

// Reset the flag at the start of every PostDataUpdate frame.
// This handler is registered first (due to import order in index.ts),
// so it executes before all other PostDataUpdate handlers.
EventsSDK.on("PostDataUpdate", () => {
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

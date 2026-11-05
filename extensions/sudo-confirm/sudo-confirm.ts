/**
 * Sudo Confirmation Extension
 *
 * Prompts for confirmation before the agent runs any bash command that uses sudo.
 * Fails closed (blocks) in non-interactive modes where no UI is available.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const sudoPattern = /\bsudo\b/;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (!sudoPattern.test(command)) return undefined;

		if (!ctx.hasUI) {
			// No interactive UI: fail closed.
			return { block: true, reason: "sudo command blocked (no UI available for confirmation)" };
		}

		const confirmed = await ctx.ui.confirm(
			"Run with sudo?",
			`Command:\n\n  ${command}`,
		);

		if (!confirmed) {
			ctx.ui.notify("sudo command cancelled", "info");
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}

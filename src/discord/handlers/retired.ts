import { InteractionType } from "discord-api-types/v10";
import { getBill } from "../../db/bills";
import type { InteractionHandler } from "../interactions";
import { editBillMessage, ephemeral } from "../rest";

export const MOVED = "That moved to the page. Tap Open the split to do it there.";

// Every custom_id these buttons and forms carried started with the bill id
// after their prefix, and bill ids are UUIDs, so the id runs to the first colon.
function billIdOf(customId: string, prefix: string): string {
  return customId.slice(prefix.length).split(":")[0] ?? "";
}

// Confirm, pay, undo, reopen and delete used to be buttons on the bill message
// and on the private prompts they opened. Those messages stay in channels long
// after a deploy, so a tap on one still answers, and the bill message is
// redrawn so the old buttons go away for everyone.
export function retired(prefix: string): InteractionHandler {
  return async (body, env, ctx) => {
    const customId =
      body.type === InteractionType.MessageComponent || body.type === InteractionType.ModalSubmit ? body.data.custom_id : "";
    const billId = billIdOf(customId, prefix);
    const bill = billId ? await getBill(env.DB, billId) : null;
    if (bill) {
      ctx.waitUntil(editBillMessage(bill, env).catch((error) => console.error("could not update the bill message", error)));
    }
    return Response.json(ephemeral(MOVED));
  };
}

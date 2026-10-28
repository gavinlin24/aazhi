import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { commands } from "../../src/discord/commands";

const ApplicationOptionAttachment = ApplicationCommandOptionType.Attachment;

const findSplit = () =>
  commands.find((c) => c.name === "split") as RESTPostAPIChatInputApplicationCommandsJSONBody | undefined;

describe("application command definitions", () => {
  it("defines /split with a required receipt attachment and two optional extra pages", () => {
    const split = findSplit();

    expect(split?.type).toBe(ApplicationCommandType.ChatInput);
    expect(split?.options?.map((o) => [o.name, o.type, o.required ?? false])).toEqual([
      ["receipt", ApplicationOptionAttachment, true],
      ["page_2", ApplicationOptionAttachment, false],
      ["page_3", ApplicationOptionAttachment, false],
    ]);
  });

  it("has no option for naming diners", () => {
    const split = findSplit();

    expect(split?.options?.some((o) => o.type !== ApplicationOptionAttachment)).toBe(false);
  });

  it("defines the message command for multi-page receipts", () => {
    const message = commands.find((c) => c.name === "Split this receipt");

    expect(message?.type).toBe(ApplicationCommandType.Message);
  });

  it("keeps every command out of DMs", () => {
    for (const command of commands) {
      expect(command.contexts).toEqual([InteractionContextType.Guild]);
    }
  });

  it("gives every command a unique name", () => {
    const names = commands.map((c) => c.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

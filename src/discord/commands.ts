import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";

// A bill belongs to a server's channel and its roster is that server's
// members, so nothing here makes sense in a DM.
const guildOnly: { contexts: InteractionContextType[]; integration_types: ApplicationIntegrationType[] } = {
  contexts: [InteractionContextType.Guild],
  integration_types: [ApplicationIntegrationType.GuildInstall],
};

// Discord takes one file per named option, so a multi-page receipt is capped
// at three slots; longer ones go through the message command below.
export const commands: RESTPutAPIApplicationCommandsJSONBody = [
  {
    ...guildOnly,
    name: "split",
    type: ApplicationCommandType.ChatInput,
    description: "Split a bill from a photo of the receipt",
    options: [
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "receipt",
        description: "A photo of the receipt",
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "page_2",
        description: "The second page, if the receipt runs over",
      },
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "page_3",
        description: "The third page, if the receipt runs over",
      },
    ],
  },
  {
    ...guildOnly,
    name: "Split this receipt",
    type: ApplicationCommandType.Message,
  },
  {
    ...guildOnly,
    name: "log",
    type: ApplicationCommandType.ChatInput,
    description: "Log your own meal from a photo of the receipt",
    options: [
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "receipt",
        description: "A photo of the receipt",
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "page_2",
        description: "The second page, if the receipt runs over",
      },
      {
        type: ApplicationCommandOptionType.Attachment,
        name: "page_3",
        description: "The third page, if the receipt runs over",
      },
    ],
  },
  // A debt belongs to a bill and a bill to a server, so the same rows answer
  // "in this server" and "everywhere". A DM with the bot has no server, so
  // there it always answers everywhere.
  {
    name: "debts",
    type: ApplicationCommandType.ChatInput,
    description: "See who owes you and who you owe",
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [
      {
        type: ApplicationCommandOptionType.Boolean,
        name: "everywhere",
        description: "Include every server, not just this one",
      },
    ],
  },
  // Boards and the @someone picker both need a server, so this has no DM form.
  {
    ...guildOnly,
    name: "profile",
    type: ApplicationCommandType.ChatInput,
    description: "See your stats, or someone else's",
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "user",
        description: "Whose profile to open",
      },
    ],
  },
];

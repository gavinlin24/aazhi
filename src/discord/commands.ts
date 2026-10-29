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
    description: "Split a restaurant bill from a photo of the receipt",
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
  // One handle per app, kept per person: whoever pays sets theirs once and
  // every later bill offers it.
  {
    ...guildOnly,
    name: "paywith",
    type: ApplicationCommandType.ChatInput,
    description: "Set how people pay you back when you cover the bill",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "method",
        description: "Which app",
        required: true,
        choices: [
          { name: "Venmo", value: "venmo" },
          { name: "Cash App", value: "cashapp" },
          { name: "Zelle", value: "zelle" },
        ],
      },
      {
        type: ApplicationCommandOptionType.String,
        name: "handle",
        description: "Your Venmo username, $Cashtag, or Zelle email or US mobile number",
        required: true,
        max_length: 254,
      },
    ],
  },
];

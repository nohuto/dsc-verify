// plain data, the node registration script imports this too

export const VERIFY_BUTTON_CUSTOM_ID = 'verification:start';

const COMMAND_TYPE_CHAT_INPUT = 1;
const OPTION_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_USER = 6;
const OPTION_TYPE_CHANNEL = 7;
const CHANNEL_TYPE_GUILD_TEXT = 0;
const CONTEXT_GUILD = 0;
const INTEGRATION_GUILD_INSTALL = 0;
const PERMISSION_MANAGE_GUILD = 1 << 5;

export type CommandOption = {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly channel_types?: readonly number[];
  readonly min_length?: number;
  readonly max_length?: number;
  readonly options?: readonly CommandOption[];
};

export type CommandDefinition = {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly contexts: readonly number[];
  readonly integration_types: readonly number[];
  readonly default_member_permissions: string | null;
  readonly options?: readonly CommandOption[];
};

function memberOption(required: boolean): CommandOption {
  return { type: OPTION_TYPE_USER, name: 'member', description: 'Member to act on', required };
}

const REASON_OPTION: CommandOption = {
  type: OPTION_TYPE_STRING,
  name: 'reason',
  description: 'Reason recorded in the audit log',
  required: true,
  min_length: 1,
  max_length: 500,
};

export const COMMANDS: readonly CommandDefinition[] = [
  {
    type: COMMAND_TYPE_CHAT_INPUT,
    name: 'verify',
    description: 'Start verification to get access to this server',
    contexts: [CONTEXT_GUILD],
    integration_types: [INTEGRATION_GUILD_INSTALL],
    default_member_permissions: null,
  },
  {
    type: COMMAND_TYPE_CHAT_INPUT,
    name: 'verification',
    description: 'Manage member verification',
    contexts: [CONTEXT_GUILD],
    integration_types: [INTEGRATION_GUILD_INSTALL],
    // controls visibility only, the backend authorizes every subcommand
    default_member_permissions: String(PERMISSION_MANAGE_GUILD),
    options: [
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'panel',
        description: 'Post or update the verification panel',
        options: [
          {
            type: OPTION_TYPE_CHANNEL,
            name: 'channel',
            description: 'Channel for the panel',
            required: true,
            channel_types: [CHANNEL_TYPE_GUILD_TEXT],
          },
        ],
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'status',
        description: "Show service status, or one member's verification status",
        options: [memberOption(false)],
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'approve',
        description: 'Approve a member without the account age and challenge checks',
        options: [memberOption(true), REASON_OPTION],
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'reset',
        description: "Cancel a member's admission and remove their access role",
        options: [memberOption(true), REASON_OPTION],
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'pause',
        description: 'Stop automatic admission',
        options: [REASON_OPTION],
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'resume',
        description: 'Resume automatic admission after a successful preflight',
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: 'delete-data',
        description: "Erase a member's verification data and log copies",
        options: [memberOption(true), REASON_OPTION],
      },
    ],
  },
];

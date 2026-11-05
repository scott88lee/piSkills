# sudo-confirm — pi extension

A pi **extension** (not a skill) that blocks any bash command containing `sudo`
until you explicitly confirm it in the terminal.

```
Run with sudo?
Command:

  sudo apt install xdotool
```

Confirm → the command runs. Decline → the tool call is blocked and the agent is
told why. In non-interactive modes (print/JSON) there is no UI to confirm with,
so it **fails closed** and blocks the command.

This is the safety counterpart to passwordless sudo: you can give the agent
`NOPASSWD` for convenience, and this extension restores a human checkpoint
before anything runs as root.

## Install

```bash
git clone https://github.com/scott88lee/piSkills
mkdir -p ~/.pi/agent/extensions
cp piSkills/extensions/sudo-confirm/sudo-confirm.ts ~/.pi/agent/extensions/
```

Or run the bundled installer:

```bash
bash piSkills/extensions/sudo-confirm/install.sh
```

Restart pi (or run `/reload`). No dependencies — pi compiles TypeScript for you
via `jiti`.

## Verify

Ask pi to run something harmless with sudo, e.g. `sudo id`. You should get a
confirmation prompt before it executes.

## Optional: passwordless sudo

Without this, an agent's `sudo` call simply cannot authenticate (a non-interactive
shell cannot type into a password prompt). Only enable it if you also install this
extension.

```bash
echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/90-$(whoami)-nopass
sudo chmod 440 /etc/sudoers.d/90-$(whoami)-nopass
sudo visudo -c
```

- `chmod 440` is required — sudo ignores world-writable sudoers files.
- `visudo -c` validates the syntax so a typo cannot break sudo.
- Revert with `sudo rm /etc/sudoers.d/90-$(whoami)-nopass`.

Prefer a narrower grant if you want:

```bash
echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/apt, /usr/bin/apt-get" \
  | sudo tee /etc/sudoers.d/90-$(whoami)-nopass
```

## Files

| File | Purpose |
| --- | --- |
| `sudo-confirm.ts` | The extension. Copy to `~/.pi/agent/extensions/`. |
| `install.sh` | Installs the extension; optionally sets up passwordless sudo. |
| `models.json.example` | Example custom model endpoint config. Copy to `~/.pi/agent/models.json`. |
| `settings.json.example` | Example user settings. Copy to `~/.pi/agent/settings.json`. |

## Related pi configuration

These are not part of the extension, but they are the other files you need when
reproducing a pi setup on a new machine. Both live in the pi agent directory
(`~/.pi/agent/`).

### `models.json` — custom OpenAI-compatible endpoint

`models.json.example` shows a self-hosted llama.cpp-style endpoint. Replace the
`baseUrl` host with your own, and `id` with a model name that endpoint serves:

```json
{
  "providers": {
    "local": {
      "baseUrl": "https://example.com/llama/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        {
          "id": "my-model",
          "input": ["text", "image"],
          "contextWindow": 112740,
          "maxTokens": 32768
        }
      ]
    }
  }
}
```

`apiKey: "none"` is a placeholder so pi lists the model; the server ignores it.
For an authenticated endpoint, `apiKey` supports `$NAME` / `${NAME}` environment
interpolation or a leading `!command`.

Opening `/model` reloads this file.

### `settings.json` — user settings

```json
{
  "hideThinkingBlock": false,
  "packages": ["npm:pi-peon-ping"]
}
```

`packages` declares pi packages (npm or git). After editing, install them:

```bash
cd ~/.pi/agent/npm && npm install
```

`lastChangelogVersion` is managed automatically by pi — you do not need to set it.

### Skills

Skills are a separate mechanism from extensions: a directory containing a
`SKILL.md` with `name` + `description` frontmatter. pi loads the full
instructions only when a task matches the description.

```bash
cp -r piSkills/web-browse ~/.agents/skills/
```

Locations pi scans: `~/.pi/agent/skills/`, `~/.agents/skills/`, and project
`.pi/skills/` / `.agents/skills/`.

## Extension vs skill

| | What it is | Location |
| --- | --- | --- |
| **Extension** | Executable behaviour (event handlers, tools, commands, providers) | `~/.pi/agent/extensions/` |
| **Skill** | Instructions pi loads on demand | `~/.agents/skills/<name>/SKILL.md` |
| **Permission** | What the OS allows the agent's shell to do | `/etc/sudoers.d/` |

Passwordless sudo is a permission, not a skill. This directory is an extension.

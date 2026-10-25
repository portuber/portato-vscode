# The Portato view

Portato manages SSH port-forwarding tunnels: the **portato** daemon holds
the config and the SSH connections, and this extension is its sidebar
client.

- The tree lists every tunnel with its live state (off, connecting,
  connected, reconnecting, error); updates stream in over SSE, no manual
  refresh needed.
- Inline actions enable, disable and restart a tunnel; the context menu
  edits, deletes, copies addresses and manages identity passphrases.
- When the daemon is missing or stopped, the view explains itself and
  offers a Start button.

Open the view with the Portato icon in the activity bar.

# Import from your SSH config

[Import forwards from SSH config](command:portato.importSsh) shows a
dry-run preview of the forwards found in `~/.ssh/config`, lets you pick
whole hosts, and writes the selection to the portato config -- the
daemon reloads it on its own. Existing tunnels are left untouched.

Also handy on the first day: [run the doctor](command:portato.doctor)
for a health report and [open the portato
config](command:portato.openConfig).

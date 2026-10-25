# Add your first tunnel

[Add tunnel](command:portato.addTunnel) opens a form that round-trips
every config field: name, type (local, remote, dynamic), addresses, SSH
target, identity file, tags and more. If the daemon's config changed while
the form was open, saving asks before overwriting; a duplicate name is
rejected with a clear message. Drag-and-drop reorders tunnels in the tree.

Already have forwards in your SSH config? The next step imports them.

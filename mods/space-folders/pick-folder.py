"""Select a remote directory using Linux's GTK file chooser and GVfs SFTP."""
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, GLib, Gtk


def choose(target, path):
    config = subprocess.run(["ssh", "-G", target], capture_output=True, text=True, check=True)
    values = dict(line.split(" ", 1) for line in config.stdout.splitlines() if " " in line)
    host = values["hostname"]
    authority = "[" + host + "]" if ":" in host else host
    uri = "sftp://{}@{}:{}/{}".format(
        quote(values["user"], safe=""), authority, values["port"], quote(path.lstrip("/"), safe="/")
    )
    dialog = Gtk.FileChooserDialog(
        title="Select folder — " + target,
        action=Gtk.FileChooserAction.SELECT_FOLDER,
    )
    dialog.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Select", Gtk.ResponseType.OK)
    dialog.set_default_response(Gtk.ResponseType.OK)
    dialog.set_local_only(False)
    dialog.set_default_size(900, 600)
    folder = Gio.File.new_for_uri(uri)
    loop = GLib.MainLoop()
    errors = []

    def mounted(source, result):
        try:
            source.mount_enclosing_volume_finish(result)
        except GLib.Error as error:
            if not error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.ALREADY_MOUNTED):
                errors.append(error.message)
        finally:
            loop.quit()

    folder.mount_enclosing_volume(Gio.MountMountFlags.NONE, Gtk.MountOperation(), None, mounted)
    loop.run()
    if errors:
        dialog.destroy()
        raise RuntimeError(errors[0])
    dialog.set_current_folder_uri(uri)
    try:
        if dialog.run() != Gtk.ResponseType.OK:
            return None
        selected = urlsplit(dialog.get_uri())
        expected = urlsplit(uri)
        if (selected.scheme, selected.hostname, selected.port or 22, selected.username) != (
            expected.scheme, expected.hostname, expected.port or 22, expected.username
        ):
            raise ValueError("Select a folder on " + target + ".")
        return unquote(selected.path)
    finally:
        dialog.destroy()


if __name__ == "__main__":
    try:
        result = {"path": choose(sys.argv[1], sys.argv[2])}
    except Exception as error:
        result = {"error": str(error)}
    if len(sys.argv) > 3:
        output = Path(sys.argv[3])
        temporary = output.with_suffix(".tmp")
        temporary.write_text(json.dumps(result))
        temporary.replace(output)
    else:
        print(json.dumps(result))

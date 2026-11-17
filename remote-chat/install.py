"""Guarded ASAR patcher. Validate all changes before replacing the installed archive."""
import argparse
import copy
import hashlib
import json
import pathlib
import shutil
import struct
from desktop_patch import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAIN = 'dist-electron/electron/main.js'
REQUIRED = {MAIN: b'startRemoteChat', 'dist-electron/electron/preload.js': b'onSharedChat'}


def read_archive(archive):
    with archive.open('rb') as f:
        sizes = struct.unpack('<4I', f.read(16))
        header = json.loads(f.read(sizes[3]))
        base = 8 + sizes[1]
        files = {}
        def visit(tree, prefix=''):
            for name, entry in tree['files'].items():
                full = prefix + name
                if 'files' in entry:
                    visit(entry, full + '/')
                elif 'offset' in entry:
                    f.seek(base + int(entry['offset']))
                    files[full] = f.read(entry['size'])
                    if len(files[full]) != entry['size']:
                        raise RuntimeError('Truncated archive: ' + full)
        visit(header)
    return header, files


def transform(files):
    result = {}
    for full, data in files.items():
        if full == MAIN:
            text = data.decode('utf8')
            marker = '        (0, agentIpc_1.registerAgentHandlers)(config, windows, agent, applySettings, life);'
            if 'startRemoteChat' not in text:
                if text.count(marker) != 1:
                    raise RuntimeError('Cannot uniquely locate agent startup; archive was not modified')
                hook = """
        // Remote web UI shares this exact runtime, persona, tools and permissions.
        require(path.join(path.dirname(electron_1.app.getPath('exe')), 'remote-chat', 'server.cjs')).startRemoteChat({
            config, agent, windows, life, app: electron_1.app,
            streamChat: aiClient_1.streamChat, notifyChannel: constants_1.IPC.petNotify,
        });"""
                text = text.replace(marker, marker + hook, 1)
            data = text.encode('utf8')
        result[full] = patch(full, data)
    for full, marker in REQUIRED.items():
        if marker not in result.get(full, b''):
            raise RuntimeError('Required remote chat patch missing: ' + full)
    renderers = [name for name, data in result.items() if name.startswith('dist/assets/') and b'__sharedChatV2' in data]
    if len(renderers) != 1:
        raise RuntimeError('Expected exactly one shared chat renderer, got ' + str(renderers))
    return result


def write_archive(target, header, files):
    header = copy.deepcopy(header)
    content = bytearray()
    def visit(tree, prefix=''):
        for name, entry in tree['files'].items():
            full = prefix + name
            if 'files' in entry:
                visit(entry, full + '/')
            elif 'offset' in entry:
                data = files[full]
                if 'integrity' in entry:
                    block = entry['integrity'].get('blockSize', 4 * 1024 * 1024)
                    entry['integrity'] = dict(algorithm='SHA256', hash=hashlib.sha256(data).hexdigest(), blockSize=block,
                        blocks=[hashlib.sha256(data[i:i+block]).hexdigest() for i in range(0, len(data), block)])
                entry['offset'] = str(len(content))
                entry['size'] = len(data)
                content.extend(data)
    visit(header)
    encoded = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf8')
    payload_size = (4 + len(encoded) + 3) & ~3
    with target.open('wb') as f:
        f.write(struct.pack('<4I', 4, payload_size + 4, payload_size, len(encoded)))
        f.write(encoded)
        f.write(b'\0' * (payload_size - 4 - len(encoded)))
        f.write(content)


def install(archive, backup_dir, check=False):
    header, files = read_archive(archive)
    patched = transform(files)
    changed = [name for name in files if files[name] != patched[name]]
    if transform(patched) != patched:
        raise RuntimeError('Patch is not idempotent; archive was not modified')
    print('Changed files:', ', '.join(changed) or '(already installed)')
    if check or not changed:
        return patched
    backup_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    backup = backup_dir / ('app.before-remote-' + digest + '.asar')
    if not backup.exists():
        shutil.copy2(archive, backup)
    if hashlib.sha256(backup.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Backup verification failed; archive was not modified')
    original = backup_dir / 'app.original.asar'
    if not original.exists():
        shutil.copy2(archive, original)
    temp = archive.with_suffix('.remote.tmp')
    try:
        write_archive(temp, header, patched)
        _, rebuilt = read_archive(temp)
        if rebuilt != patched:
            raise RuntimeError('Rebuilt archive verification failed')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Archive changed during installation; refusing to overwrite')
        temp.replace(archive)
    finally:
        temp.unlink(missing_ok=True)
    print('Installed remote chat. Verified current-version backup:', backup)
    return patched


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate patches without changing the archive')
    args = parser.parse_args()
    install(ROOT / 'resources/app.asar', ROOT / 'remote-chat/backups', check=args.check)

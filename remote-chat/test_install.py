"""Regression checks against the installed build, without modifying it."""
import pathlib
import tempfile
import unittest
from install import ROOT, MAIN, read_archive, transform, write_archive, install


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.header, cls.files = read_archive(ROOT / 'resources/app.asar')

    def test_current_build_and_new_asset_hash(self):
        patched = transform(self.files)
        self.assertEqual(transform(patched), patched)
        self.assertEqual(patched[MAIN].count(b'.startRemoteChat('), 1)
        renderer = next(n for n, d in patched.items() if b'__sharedChatV2' in d)
        self.assertIn(b'streaming:i?ui(', patched[renderer])
        renamed = dict(self.files)
        renamed['dist/assets/index-futureBuild123.js'] = renamed.pop(renderer)
        self.assertIn(b'__sharedChatV2', transform(renamed)['dist/assets/index-futureBuild123.js'])

    def test_missing_startup_or_renderer_fails_closed(self):
        for missing in [MAIN, next(n for n in self.files if n.startswith('dist/assets/index-') and n.endswith('.js'))]:
            files = dict(self.files)
            del files[missing]
            with self.assertRaises(RuntimeError):
                transform(files)

    def test_roundtrip_backup_and_repeat_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / 'app.asar'
            backups = root / 'backups'
            write_archive(archive, self.header, self.files)
            before = archive.read_bytes()
            patched = install(archive, backups)
            self.assertEqual(read_archive(archive)[1], patched)
            self.assertEqual(next(backups.glob('app.before-remote-*.asar')).read_bytes(), before)
            after = archive.read_bytes()
            install(archive, backups)
            self.assertEqual(archive.read_bytes(), after)
            self.assertEqual(len(list(backups.glob('app.before-remote-*.asar'))), 1)


if __name__ == '__main__':
    unittest.main()

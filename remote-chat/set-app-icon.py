"""Use the existing character portrait as Windows icon; preserve other PE resources."""
import ctypes as c
from ctypes import wintypes as w
import pathlib
import struct
import sys
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / 'remote-chat/public/avatar.ico'
EXE = ROOT / 'Chibi Desktop Pet.exe'
api = c.WinDLL('kernel32', use_last_error=True)
api.LoadLibraryExW.argtypes = [w.LPCWSTR, w.HANDLE, w.DWORD]
api.LoadLibraryExW.restype = w.HMODULE
api.FreeLibrary.argtypes = [w.HMODULE]
api.FindResourceExW.argtypes = [w.HMODULE, c.c_void_p, c.c_void_p, w.WORD]
api.FindResourceExW.restype = w.HRSRC
api.SizeofResource.argtypes = [w.HMODULE, w.HRSRC]
api.SizeofResource.restype = w.DWORD
api.LoadResource.argtypes = [w.HMODULE, w.HRSRC]
api.LoadResource.restype = w.HGLOBAL
api.LockResource.argtypes = [w.HGLOBAL]
api.LockResource.restype = c.c_void_p
api.BeginUpdateResourceW.argtypes = [w.LPCWSTR, w.BOOL]
api.BeginUpdateResourceW.restype = w.HANDLE
api.UpdateResourceW.argtypes = [w.HANDLE, c.c_void_p, c.c_void_p, w.WORD, c.c_void_p, w.DWORD]
api.EndUpdateResourceW.argtypes = [w.HANDLE, w.BOOL]
NAME_CB = c.WINFUNCTYPE(w.BOOL, w.HMODULE, c.c_void_p, c.c_void_p, c.c_ssize_t)
LANG_CB = c.WINFUNCTYPE(w.BOOL, w.HMODULE, c.c_void_p, c.c_void_p, w.WORD, c.c_ssize_t)
api.EnumResourceNamesW.argtypes = [w.HMODULE, c.c_void_p, NAME_CB, c.c_ssize_t]
api.EnumResourceLanguagesW.argtypes = [w.HMODULE, c.c_void_p, c.c_void_p, LANG_CB, c.c_ssize_t]
def name_value(pointer):
    return pointer if pointer < 65536 else c.wstring_at(pointer)
def resource_name(value):
    return value if isinstance(value, int) else c.cast(c.c_wchar_p(value), c.c_void_p)
def inventory(module, kind):
    rows = []
    @NAME_CB
    def on_name(h, t, n, _):
        name = name_value(n)
        @LANG_CB
        def on_lang(h, t, n, lang, _):
            rows.append((name, lang)); return True
        api.EnumResourceLanguagesW(h, t, n, on_lang, 0)
        return True
    api.EnumResourceNamesW(module, kind, on_name, 0)
    return rows
def check(value):
    if not value: raise c.WinError(c.get_last_error())
    return value
def main():
    Image.open(ROOT / 'remote-chat/app-source/build/icon.png').save(ICON, format='ICO', sizes=[(n,n) for n in [16,24,32,48,64,128,256]])
    ico = ICON.read_bytes()
    count = struct.unpack_from('<H', ico, 4)[0]
    entries = [struct.unpack_from('<BBBBHHII', ico, 6 + 16*i) for i in range(count)]
    module = check(api.LoadLibraryExW(str(EXE), None, 2))
    try:
        groups = inventory(module, 14) or [(1, 1033)]
        first = max([n for n, _ in inventory(module, 3) if isinstance(n, int)] + [0]) + 1
    finally: api.FreeLibrary(module)
    group = struct.pack('<HHH', 0, 1, count)
    for i, entry in enumerate(entries):
        group += struct.pack('<BBBBHHIH', *entry[:7], first + i)
    if '--verify' not in sys.argv:
        update = check(api.BeginUpdateResourceW(str(EXE), False))
        try:
            for lang in {lang for _, lang in groups}:
                for i, entry in enumerate(entries):
                    data = ico[entry[7]:entry[7] + entry[6]]
                    buf = c.create_string_buffer(data)
                    check(api.UpdateResourceW(update, 3, first+i, lang, buf, len(data)))
            for name, lang in groups:
                buf = c.create_string_buffer(group)
                check(api.UpdateResourceW(update, 14, resource_name(name), lang, buf, len(group)))
        except BaseException:
            api.EndUpdateResourceW(update, True); raise
        check(api.EndUpdateResourceW(update, False))
    module = check(api.LoadLibraryExW(str(EXE), None, 2))
    try:
        def read(kind, name, lang):
            res = check(api.FindResourceExW(module, kind, resource_name(name), lang))
            return c.string_at(check(api.LockResource(check(api.LoadResource(module, res)))), api.SizeofResource(module, res))
        for name, lang in inventory(module, 14):
            actual = read(14, name, lang)
            assert struct.unpack_from('<HHH', actual)[2] == count
            for i, entry in enumerate(entries):
                icon_id = struct.unpack_from('<H', actual, 6 + 14*i + 12)[0]
                assert read(3, icon_id, lang) == ico[entry[7]:entry[7]+entry[6]]
    finally: api.FreeLibrary(module)
    print(f'Verified avatar icon: {count} sizes, {len(groups)} icon group(s).')
if __name__ == '__main__': main()

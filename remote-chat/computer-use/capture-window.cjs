'use strict';
// Capture the selected HWND, never a rectangle of whichever desktop is visible.
async function captureWindowImage(meta, electron, signal, fixture = null) {
  signal?.throwIfAborted();
  const width = meta.right - meta.left, height = meta.bottom - meta.top;
  const sources = await electron.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  signal?.throwIfAborted();
  const source = sources.find(s => s.id?.split(':')[0] === 'window' && s.id.split(':')[1] === String(meta.handle));
  if ((!source || source.thumbnail.isEmpty()) && fixture) {
    // Electron 33 omits its own process windows from desktopCapturer. Only
    // the backend's explicitly allowed, local synthetic fixture can use this.
    const image = await fixture.webContents.capturePage(); signal?.throwIfAborted();
    if (image.isEmpty()) throw new Error('本地测试页面采集失败');
    return { image, contentOnly: true };
  }
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法采集指定窗口的画面；未改用桌面截图，也没有执行输入。窗口可能隐藏、受保护或不支持窗口采集');
  let image = source.thumbnail;
  const size = image.getSize();
  if (size.width < 40 || size.height < 40 || Math.abs((size.width / size.height) / (width / height) - 1) > .06) throw new Error('窗口截图尺寸与目标窗口不一致，不能可靠定位；没有执行输入');
  if (Math.max(size.width, size.height) > 1440) image = image.resize(size.width >= size.height ? { width: 1440 } : { height: 1440 });
  return { image, contentOnly: false };
}
module.exports = { captureWindowImage };

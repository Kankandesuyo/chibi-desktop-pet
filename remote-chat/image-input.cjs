'use strict';
const MAX_BYTES = 5 * 1024 * 1024;
function bad(message) { throw Object.assign(new Error(message), { status: 400 }); }
function dimensions(buffer) {
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && buffer.toString('ascii', 12, 16) === 'IHDR') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  if (buffer[0] === 255 && buffer[1] === 216) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 255) break;
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3), format: 'jpeg' };
      offset += length;
    }
  }
  bad('请选择有效的 PNG 或 JPG 图片');
}
function decodeUpload(image, normalize) {
  if (!image || typeof image !== 'object' || typeof image.dataUrl !== 'string' || image.dataUrl.length > 7 * 1024 * 1024) bad('图片格式无效或超过 5 MB');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match) bad('只支持 PNG 和 JPG 图片');
  const raw = Buffer.from(match[2], 'base64');
  if (!raw.length || raw.length > MAX_BYTES || raw.toString('base64') !== match[2]) bad('图片格式无效或超过 5 MB');
  const size = dimensions(raw);
  if (!size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height > 16000000) bad('图片尺寸过大，请先缩小到 1600 万像素以内');
  const result = normalize(raw);
  if (!result?.buffer?.length || result.buffer.length > 17 * 1024 * 1024) bad('图片无法解码，请重新导出为 PNG 或 JPG');
  return { ...result, name: String(image.name || '图片').replace(/[\x00-\x1f<>/\\]/g, '_').slice(0, 120) };
}
function normalizeWithElectron(raw) {
  const { nativeImage } = require('electron');
  let image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) bad('图片无法解码');
  const size = image.getSize();
  if (Math.max(size.width, size.height) > 2048) image = image.resize({ ...(size.width >= size.height ? { width: 2048 } : { height: 2048 }), quality: 'best' });
  return { buffer: image.toPNG(), ...image.getSize() };
}
module.exports = { MAX_BYTES, dimensions, decodeUpload, normalizeWithElectron };

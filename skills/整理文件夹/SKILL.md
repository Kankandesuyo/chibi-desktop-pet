---
name: 整理文件夹
description: 用户要整理某个文件夹（桌面、下载等），按文件类型分进子文件夹时使用
---

# 整理文件夹（按类型）

1. 不确定是哪个文件夹时，先用 get_known_folders 查到真实路径，不要猜。
2. 用 list_directory 看一下里面有什么，统计各类文件的数量。只整理这一层的文件，**不动已有的子文件夹**，也不动快捷方式（.lnk）。
3. 按扩展名分类，没有对应文件的类别就不要建文件夹：
   - 图片：.jpg .jpeg .png .gif .webp .bmp .heic .svg
   - 文档：.pdf .doc .docx .xls .xlsx .ppt .pptx .txt .md .csv
   - 压缩包：.zip .rar .7z .tar .gz
   - 安装包：.exe .msi
   - 视频：.mp4 .mov .mkv .avi
   - 音乐：.mp3 .wav .flac .m4a
   - 其他：剩下的留在原地，不用移动
4. 先用 update_plan 列出计划，然后对每个需要的类别用 create_directory 建子文件夹。
5. 用 **一次** move_files 给出完整的移动清单（用户会看到预览并确认），不要一个个移。目标里已经有同名文件的跳过，并在汇报里说明。
6. 汇报：每类移动了多少个、跳过了哪些。告诉用户说一声“撤销刚才的整理”就能用 undo_file_operations 恢复。

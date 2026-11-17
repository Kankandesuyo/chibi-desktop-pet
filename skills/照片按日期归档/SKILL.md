---
name: 照片按日期归档
description: 用户要把一堆照片/截图按年份月份分文件夹归档时使用
---

# 照片按日期归档

1. 确认源文件夹（不确定就问用户或用 get_known_folders 查“图片”文件夹）。
2. 用 search_files 找出图片文件：extensions=[".jpg",".jpeg",".png",".heic",".webp"]，maxDepth=0（只看这一层）；用户说包括子文件夹时才去掉 maxDepth。
3. 每个文件用 search_files 结果里的 modified（修改时间）决定归到哪个月。告诉用户：这里用的是文件的修改时间，不一定是拍摄时间。
4. 目标结构：`<源文件夹>\YYYY\YYYY-MM\`，例如 `图片\2026\2026-11\`。只建有照片的月份。
5. update_plan 列出步骤 → create_directory 建需要的文件夹 → **一次** move_files 给出完整清单（用户会看到预览并确认）。同名冲突的跳过并说明。
6. 汇报：一共归档多少张，分到了哪些月份，跳过了哪些。可以说一声“撤销”恢复。

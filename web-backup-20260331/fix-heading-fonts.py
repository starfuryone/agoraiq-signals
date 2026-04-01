#!/usr/bin/env python3
import re, glob, os, shutil

WEB_ROOT = "/opt/agoraiq-signals/web"
os.chdir(WEB_ROOT)

files = sorted(glob.glob("*.html"))
total_fixes = 0

for fname in files:
    with open(fname, "r", encoding="utf-8", errors="replace") as f:
        original = f.read()

    content = original
    counter = [0]

    def strip_in_style_blocks(text):
        style_blocks = list(re.finditer(r'(<style[^>]*>)(.*?)(</style>)', text, re.DOTALL | re.IGNORECASE))
        if not style_blocks:
            return text
        result = text
        offset = 0
        for m in style_blocks:
            style_content = m.group(2)
            def replace_heading_font(rule_match):
                rule = rule_match.group(0)
                selector = rule_match.group(1)
                if re.search(r'\bh[1-6]\b', selector, re.IGNORECASE):
                    new_rule, count = re.subn(r'font-family\s*:\s*[^;]+;\s*', '/* inherited from styles.css */ ', rule)
                    if count > 0:
                        counter[0] += count
                        return new_rule
                return rule
            new_style = re.sub(r'([^{}]+?)\{([^{}]*)\}', replace_heading_font, style_content)
            start = m.start(2) + offset
            end = m.end(2) + offset
            result = result[:start] + new_style + result[end:]
            offset += len(new_style) - len(style_content)
        return result

    content = strip_in_style_blocks(content)

    def strip_inline(match):
        tag = match.group(0)
        new_tag, count = re.subn(r'font-family\s*:\s*[^;]+;\s*', '', tag)
        if count > 0:
            counter[0] += count
            new_tag = re.sub(r'\s+style\s*=\s*"\s*"', '', new_tag)
            return new_tag
        return tag

    content = re.sub(r'<h[1-6][^>]*style="[^"]*font-family[^"]*"[^>]*>', strip_inline, content, flags=re.IGNORECASE)

    fixes = counter[0]
    if content != original:
        bak = fname + ".font-bak"
        if not os.path.exists(bak):
            shutil.copy2(fname, bak)
            print(f"  BAK   {fname} -> {bak}")
        with open(fname, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"  OK    {fname}  ({fixes} stripped)")
        total_fixes += fixes
    else:
        print(f"  -     {fname}  (clean)")

print(f"\nDone. {total_fixes} total stripped across {len(files)} files.")

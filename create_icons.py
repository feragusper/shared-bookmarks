#!/usr/bin/env python3
from PIL import Image, ImageDraw
import os

# Create icons folder if it doesn't exist
os.makedirs('/Users/A200752/IdeaProjects/shared-bookmarks/icons', exist_ok=True)

# Colors
bg_color = (59, 89, 152)  # Blue
accent_color = (255, 255, 255)  # White
bookmark_color = (255, 51, 51)  # Red

def create_icon(size):
    # Create image with blue background
    img = Image.new('RGBA', (size, size), bg_color)
    draw = ImageDraw.Draw(img)

    # Draw a bookmark shape (simplified rectangle with a notch at bottom)
    padding = size // 6
    x0, y0 = padding, padding
    x1, y1 = size - padding, size - padding

    # Bookmark rectangle
    draw.rectangle([x0, y0, x1, y1], fill=bookmark_color)

    # Notch at bottom (triangle shape)
    notch_size = size // 4
    mid_x = size // 2
    bottom_y = y1
    draw.polygon(
        [(mid_x - notch_size, bottom_y),
         (mid_x + notch_size, bottom_y),
         (mid_x, bottom_y + notch_size)],
        fill=bg_color
    )

    # Add a small white circle in the center as accent
    circle_radius = size // 10
    draw.ellipse(
        [mid_x - circle_radius, y0 + padding - 2,
         mid_x + circle_radius, y0 + padding + circle_radius * 2 - 2],
        fill=accent_color
    )

    return img

# Create icons in different sizes
sizes = {
    'icon16.png': 16,
    'icon48.png': 48,
    'icon128.png': 128
}

for filename, size in sizes.items():
    icon = create_icon(size)
    path = f'/Users/A200752/IdeaProjects/shared-bookmarks/icons/{filename}'
    icon.save(path)
    print(f"✓ Created {filename} ({size}x{size})")

print("\nAll icons created successfully!")


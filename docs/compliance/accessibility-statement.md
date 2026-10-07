---
key: accessibility
title: Accessibility statement
summary: How accessible Materia is, the standard it aims for, what isn't accessible yet, and how to tell us about a problem.
version: 0.1
effective: 2026-10-07
status: draft
order: 7
---

# Accessibility statement

> **Draft — not yet reviewed.** This statement is published before the manual screen reader audit (SEC-06a) is finished, and the contact details in square brackets are still to be completed. It will be updated when that audit is done.

Materia is practice software for Australian wills and estates lawyers. We want everyone at a firm to be able to use it, including people who use a screen reader, a keyboard instead of a mouse, magnification, voice control or high-contrast settings.

This statement applies to the Materia web app, in desktop and mobile browsers.

## The standard we aim for

We aim to meet the [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/) at level AA. These guidelines explain how to make web content usable by people with a wide range of disabilities.

## Conformance status

Materia is **partially conformant** with WCAG 2.2 level AA. Partially conformant means that some parts of the content don't fully conform yet.

We say "partially" because the manual testing with screen readers (VoiceOver on macOS and iOS, and NVDA on Windows) isn't finished. Everything we can test automatically and with scripted checks passes. We'll update this statement when the screen reader testing is complete.

## What we've checked

On 7 October 2026 we audited the app against WCAG 2.2 level AA:

- **Automated testing.** Every page and the key dialogs, in the light and the dark theme, on a desktop browser and at phone size. No critical or serious problems remain.
- **Keyboard only.** Signing in, Today, a matter, Settings and the dialogs work without a mouse. Focus is always visible, including in Windows high-contrast themes, and never gets stuck.
- **Zoom and reflow.** Pages reflow at 200% and 400% zoom without scrolling sideways. Wide tables scroll inside their own frame.
- **Reduced motion.** When your device asks for reduced motion, Materia's animations and transitions are turned off.
- **Colour contrast.** Text and controls meet the AA contrast ratios in both themes, with the one exception below.
- **Signing in.** You can paste and autofill your password and your two-step code. There is no puzzle or memory test.
- **Dragging.** Anything you can drag, such as a matter on the board or a task in a list, can also be moved with a button or a menu.
- **Screen reader announcements.** Notifications are announced politely. Clerk, the AI assistant, doesn't read its answer out word by word as it's written; it announces the answer once it has finished.
- **Help.** Help is in the same place on every page: the keyboard shortcuts in the account menu, and the guide to Clerk at the foot of the Clerk panel.

## Known limitations

- **White text on the action blue.** White text on Materia's action blue (#346CFC) has a contrast ratio of 4.47:1, just under the 4.5:1 that WCAG asks for small text (success criterion 1.4.3). Our design allows it only for labels of 13px medium weight or larger. Where white text sits on blue in the app today (primary buttons, today's date in the deadline calendar and unread counts on phones), we use a darker blue, #2459E6, which gives 5.76:1.
- **Document previews.** The preview of a PDF shows each page as an image, so a screen reader can't read the text in the preview. Download the document to read it in an app of your choice; it keeps whatever accessibility the original file has. We're working on a readable text layer for the preview.
- **Screen reader testing.** Until the manual screen reader audit is done, there may be problems that only a screen reader shows, such as a control announced with the wrong name or state.

## Feedback

Tell us if something in Materia is hard to use, or if you need information in another format. Email [accessibility contact email]. We aim to reply within [number] business days.

If you aren't happy with our response, you can contact the [Australian Human Rights Commission](https://humanrights.gov.au/complaints).

## How we keep it accessible

Every change to Materia is tested automatically for accessibility before it's released, and the full audit of every page runs every morning. New features are designed with the keyboard, screen readers and both themes in mind.

This statement was prepared on 7 October 2026.

import { expect, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

// Broadcast operator: a regular player (Player3) is designated as operator,
// gets the Director with only the Controls and Presets tabs, and drives world
// settings through the GM relay. The OBS client keeps not seeing the Director.
test.describe('Broadcast Operator', () => {
	test('operator drives the stream through the GM relay', async ({
		pages: { gmPage, obsPage, playerPage },
	}) => {
		const playerId = await playerPage.evaluate(
			// @ts-expect-error run in plain js
			() => window.game.user.id,
		);

		const before = await gmPage.evaluate(
			// @ts-expect-error run in plain js
			() => window.game.settings.get('obs-utils', 'pauseCameraTracking'),
		);
		try {
			// GM assigns the operator; the role applies after the client reloads.
			// Inside the try so a failed reload still reaches the revocation below.
			await gmPage.evaluate(
				// @ts-expect-error run in plain js
				id => window.game.settings.set('obs-utils', 'broadcastOperatorUserId', id),
				playerId,
			);
			await playerPage.reload();
			// @ts-expect-error run in plain js
			await playerPage.waitForFunction(() => window.game?.ready);

			// The Director button appears for the operator; the window opens with
			// exactly the Controls and Presets tabs.
			await playerPage.locator('button[data-tool=openStreamDirector]').click();
			await expect(playerPage.locator('div[id=director-application]')).toBeVisible();
			await expect(
				playerPage.locator('div[id=director-application] .tab-bar button[role=tab] span'),
			).toHaveText(['Controls', 'Presets']);

			// The OBS client is not a Director user (showDirectorInOBSMode is off).
			await expect(obsPage.locator('button[data-tool=openStreamDirector]')).toHaveCount(0);

			// Operator flips pause tracking → relay → the GM client writes the world
			// setting → every client (including OBS) sees the new value.
			await playerPage
				.locator('div[id=director-application] label[for=pauseCameraTracking]')
				.click();
			await gmPage.waitForFunction(
				// @ts-expect-error run in plain js
				prev => window.game.settings.get('obs-utils', 'pauseCameraTracking') !== prev,
				before,
			);
			await obsPage.waitForFunction(
				// @ts-expect-error run in plain js
				prev => window.game.settings.get('obs-utils', 'pauseCameraTracking') !== prev,
				before,
			);
		} finally {
			// Restore the world for the rest of the serial suite even when an
			// assertion above fails: pauseCameraTracking suppresses all OBS camera
			// movement and would poison every later viewport test.
			await gmPage.evaluate(
				// @ts-expect-error run in plain js
				prev => window.game.settings.set('obs-utils', 'pauseCameraTracking', prev),
				before,
			);
			// Revoke the role and confirm the Director disappears after reload.
			await gmPage.evaluate(
				// @ts-expect-error run in plain js
				() => window.game.settings.set('obs-utils', 'broadcastOperatorUserId', 'none'),
			);
			await playerPage.reload();
			// @ts-expect-error run in plain js
			await playerPage.waitForFunction(() => window.game?.ready);
		}
		// Anchor on the toolbar having rendered before asserting the absence, so
		// this can't pass vacuously against a not-yet-painted controls bar.
		await expect(playerPage.locator('button[data-tool]').first()).toBeVisible();
		await expect(playerPage.locator('button[data-tool=openStreamDirector]')).toHaveCount(0);
	});
});

<svelte:options runes={true} />
<script>
	// Minimal stand-in for a Director tab in DirectorApp tests.
	const { disabled = false } = $props();
</script>

<div class='dummy-tab' data-disabled={disabled}></div>

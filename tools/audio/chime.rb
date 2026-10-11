# The MUSIC slider's audition when no theme is playing: one soft bell chord in
# the game's key, so the level being set is the level of something musical.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 5.5 do
  with_fx :reverb, room: 0.6, mix: 0.35 do
    use_synth :pretty_bell
    play chord(:d4, :major), amp: 0.3, release: 0.9
    sleep 0.09
    play :a5, amp: 0.15, release: 0.7
  end
end

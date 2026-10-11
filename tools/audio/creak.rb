# Timber under strain: a slow wooden creak, stick-slip quickening as it
# rises a little in pitch. The game plays it slower and deeper the harder
# the most-loaded member is working, and more often (see src/ui/audio.js).
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 3.5 do
  with_fx :reverb, room: 0.3, mix: 0.15 do
    with_fx :bpf, centre: 70, res: 0.55 do
      with_fx :slicer, phase: 0.06, phase_slide: 0.6, wave: 0, mix: 1 do |sl|
        control sl, phase: 0.028
        use_synth :saw
        s = play 40, note_slide: 0.6, attack: 0.08, sustain: 0.35, release: 0.25, amp: 0.9
        control s, note: 43
        sleep 0.7
      end
    end
  end
end

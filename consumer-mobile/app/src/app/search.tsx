import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, Icon, Row, Screen, SectionTitle, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { track } from '@/lib/analytics';
import { startVoiceInput } from '@/lib/speech';
import { getHomeRepository, getSearchRepository } from '@/repos';
import { useSavedSearchesStore } from '@/store/savedSearches';
import { toast } from '@/store/ui';

export default function SearchScreen() {
  const router = useRouter();
  const { category, q: qParam } = useLocalSearchParams<{ category?: string; q?: string }>();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(category ?? null);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [imageSearching, setImageSearching] = useState(false);
  const [pickedImage, setPickedImage] = useState<string | null>(null);
  const ranInitialQuery = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const voiceSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useSavedSearchesStore((s) => s.saved);
  const saveSearch = useSavedSearchesStore((s) => s.saveSearch);
  const removeSavedSearch = useSavedSearchesStore((s) => s.removeSavedSearch);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await getSearchRepository().history());
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // Category chips come from the home feed; failures are non-fatal.
  useEffect(() => {
    getHomeRepository()
      .getHomeFeed()
      .then((feed) => setCategories((feed.categories ?? []).map((c) => c.name)))
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  const clearHistory = useCallback(async () => {
    try {
      await getSearchRepository().clearHistory();
      setRecent([]);
      toast(t('search.clearHistory'));
    } catch {
      toast(t('common.error'), 'error');
    }
  }, []);

  // Debounced suggestions (300 ms) — never a request per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        setSuggestions(await getSearchRepository().suggest(q));
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const submit = async (q: string, categoryOverride?: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const cat = categoryOverride ?? activeCategory;
    await getSearchRepository().addToHistory(trimmed);
    track({ name: 'search_submitted', query: trimmed, category: cat ?? undefined });
    router.push({
      pathname: '/search-results',
      params: cat ? { q: trimmed, category: cat } : { q: trimmed },
    });
  };

  // Voice transcript → the results screen re-runs POST /search/voice from the
  // voice param. The short debounce lets the transcript settle in the input
  // before the search fires (mirrors the 300 ms suggestion debounce below).
  const submitVoice = useCallback(
    (transcript: string) => {
      const trimmed = transcript.trim();
      if (!trimmed) return;
      void getSearchRepository()
        .addToHistory(trimmed)
        .catch(() => {
          /* non-fatal */
        });
      track({ name: 'search_submitted', query: trimmed });
      router.push({ pathname: '/search-results', params: { q: trimmed, voice: '1' } });
    },
    [router],
  );

  const onMicPress = useCallback(async () => {
    if (listening) return;
    setListening(true);
    const result = await startVoiceInput((transcript) => {
      if (!transcript) return;
      setQuery(transcript);
      if (voiceSubmitTimer.current) clearTimeout(voiceSubmitTimer.current);
      voiceSubmitTimer.current = setTimeout(() => submitVoice(transcript), 300);
    });
    setListening(false);
    if (!result.ok && (result.error === 'VOICE_UNSUPPORTED' || result.error === 'VOICE_PERMISSION_DENIED')) {
      // Honest fallback: recognition unavailable (node/native/browser without
      // SpeechRecognition) or mic denied → the user types instead.
      // VOICE_NO_SPEECH / VOICE_FAILED stop silently — the indicator is off.
      toast(t('search.voiceUnsupported'), 'info');
      inputRef.current?.focus();
    }
  }, [listening, submitVoice]);

  const onImagePress = useCallback(async () => {
    if (imageSearching) return;
    setImageSearching(true);
    try {
      // expo-image-picker is lazy-imported so the node test bundle never
      // loads it (same seam as book.tsx photo intake).
      const Picker = await import('expo-image-picker');
      if (typeof Picker.requestMediaLibraryPermissionsAsync === 'function') {
        const perm = await Picker.requestMediaLibraryPermissionsAsync(true);
        if (!perm.granted) {
          toast(t('search.imageDenied'), 'info');
          return;
        }
      }
      const result = await Picker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 0.7,
      });
      if (result.canceled) return;
      const uri = result.assets[0]?.uri;
      if (!uri) return;
      setPickedImage(uri);
      // Contract ImageSearchBody {imageUrl}: the local URI is the upload-less
      // mock key — a live app uploads the photo first and sends the returned
      // URL. The results screen re-runs the same endpoint from the image param.
      try {
        await getSearchRepository().imageSearch({ imageUrl: uri });
      } catch {
        /* the results screen surfaces the failure with retry */
      }
      track({ name: 'search_submitted', query: t('search.image') });
      router.push({ pathname: '/search-results', params: { q: t('search.image'), image: uri } });
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setImageSearching(false);
    }
  }, [imageSearching, router]);

  // Clear the pending voice submit on unmount so a transcript never navigates
  // from a dead screen.
  useEffect(
    () => () => {
      if (voiceSubmitTimer.current) clearTimeout(voiceSubmitTimer.current);
    },
    [],
  );

  // Saved-search tap from the favorites hub (/search?q=…) runs the search
  // immediately; the ref guards against remount double-runs.
  useEffect(() => {
    if (ranInitialQuery.current) return;
    if (!qParam || !qParam.trim()) return;
    ranInitialQuery.current = true;
    setQuery(qParam);
    void submit(qParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam]);

  const saveCurrent = () => {
    const q = query.trim();
    if (!q) return;
    if (saveSearch(q)) toast(t('search.savedAdded'));
    else toast(t('search.savedAlready'), 'info');
  };

  const currentSaved = query.trim().length > 0 && saved.includes(query.trim());

  const saveStar = (
    <Pressable
      onPress={saveCurrent}
      disabled={!query.trim()}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('search.save')}
      accessibilityState={{ disabled: !query.trim() }}>
      <Icon name={currentSaved ? 'star' : 'star-outline'} size={18} color={currentSaved ? Colors.gold : query.trim() ? Colors.textSecondary : Colors.textTertiary} />
    </Pressable>
  );

  return (
    <Screen scroll>
      <View style={styles.searchRow}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="arrow-back" size={22} color={Colors.text} />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={setQuery}
          onFocus={() => track({ name: 'search_started' })}
          onSubmitEditing={() => submit(query)}
          placeholder={t('search.placeholder')}
          placeholderTextColor={Colors.textTertiary}
          autoFocus
          accessibilityLabel={t('search.placeholder')}
          returnKeyType="search"
          style={styles.input}
        />
        <Pressable
          onPress={onMicPress}
          disabled={listening}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('search.voice')}
          accessibilityState={{ disabled: listening, busy: listening }}>
          <Icon name={listening ? 'mic' : 'mic-outline'} size={22} color={listening ? Colors.primary : Colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={onImagePress}
          disabled={imageSearching}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('search.image')}
          accessibilityState={{ disabled: imageSearching, busy: imageSearching }}>
          <Icon name={imageSearching ? 'hourglass-outline' : 'image-outline'} size={22} color={imageSearching ? Colors.primary : Colors.textSecondary} />
        </Pressable>
      </View>

      {/* Static listening/searching indicator — no animation, reduced-motion safe. */}
      {listening ? (
        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{t('search.listening')}</Text>
        </View>
      ) : null}
      {imageSearching && pickedImage ? (
        <View style={styles.statusRow}>
          <Image source={{ uri: pickedImage }} style={styles.thumb} />
          <Text style={styles.statusText}>{t('search.imageSearching')}</Text>
        </View>
      ) : null}

      {categories.length > 0 ? (
        <View style={{ marginTop: Spacing.md }}>
          <Text style={styles.filtersLabel}>{t('search.filters')}</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: Spacing.sm }}>
            <Chip label={t('search.all')} selected={!activeCategory} onPress={() => setActiveCategory(null)} />
            {categories.map((c) => (
              <Chip
                key={c}
                label={c}
                selected={activeCategory === c}
                onPress={() => {
                  setActiveCategory(c);
                  if (query.trim()) submit(query, c);
                }}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {loading ? (
        <SkeletonCard rows={3} />
      ) : suggestions.length > 0 ? (
        <View style={{ marginTop: Spacing.md }}>
          {suggestions.map((s) => (
            <Pressable key={s} onPress={() => submit(s)} style={styles.suggestion} accessibilityRole="button">
              <Icon name="search" size={16} color={Colors.textTertiary} />
              <Text style={styles.suggestionText}>{s}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <>
          {recent.length > 0 ? (
            <>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.lg, marginBottom: Spacing.md }}>
                <Row gap={6}>
                  <Icon name="time-outline" size={15} color={Colors.textTertiary} />
                  <Text style={styles.sectionTitle}>{t('search.recent')}</Text>
                </Row>
                <Row gap={Spacing.md}>
                  {saveStar}
                  <Pressable onPress={clearHistory} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('search.clear')}>
                    <Text style={styles.clearAction}>{t('search.clear')} ›</Text>
                  </Pressable>
                </Row>
              </Row>
              <View style={styles.chips}>
                {recent.map((r) => (
                  <Chip key={r} label={r} onPress={() => submit(r)} />
                ))}
              </View>
            </>
          ) : null}
          <Row style={{ justifyContent: 'space-between', marginTop: Spacing.lg, marginBottom: Spacing.md }}>
            <Row gap={6}>
              <Icon name="star-outline" size={15} color={Colors.textTertiary} />
              <Text style={styles.sectionTitle}>{t('search.saved')}</Text>
            </Row>
            {saveStar}
          </Row>
          {saved.length > 0 ? (
            <View style={styles.chips}>
              {saved.map((s) => (
                <Row key={s} gap={Spacing.xs}>
                  <Chip label={s} onPress={() => submit(s)} />
                  <Pressable
                    onPress={() => {
                      removeSavedSearch(s);
                      toast(t('search.savedRemoved'));
                    }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('search.savedRemove', { query: s })}>
                    <Icon name="close-circle" size={18} color={Colors.textTertiary} />
                  </Pressable>
                </Row>
              ))}
            </View>
          ) : (
            <Text style={styles.savedEmpty}>{t('search.savedEmpty')}</Text>
          )}
          <SectionTitle title={t('search.suggestions')} icon="sparkles-outline" />
          <View style={styles.chips}>
            {['Chicken & Chips', 'Plumber', 'Pilau', 'Smoothie'].map((s) => (
              <Chip key={s} label={s} onPress={() => submit(s)} />
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  input: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md - 1,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
  },
  filtersLabel: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md },
  suggestionText: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontFamily: Fonts.sansExtraBold,
    color: Colors.text,
    letterSpacing: 0.2,
  },
  clearAction: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium },
  savedEmpty: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sans },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm, marginLeft: Spacing.xl },
  statusDot: { width: Spacing.sm + 2, height: Spacing.sm + 2, borderRadius: Radius.pill, backgroundColor: Colors.primary },
  statusText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  thumb: { width: 28, height: 28, borderRadius: Radius.sm },
});

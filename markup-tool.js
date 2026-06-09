// Trimble Connect Attribute Markup Tool v3.0
// Uses official Workspace API TextMarkup to display property labels
// Now supports selection API for batch/area selection

class AttributeMarkupTool {
    constructor() {
        this.api = null;
        this.markupIds = []; // Track created text markup IDs
        this.pointMarkupIds = []; // Track created point markup IDs
        this.lineMarkupIds = []; // Track created line markup IDs
        this.measurementMarkupIds = []; // Track created measurement markup IDs
        this.propertyNames = ['Name', 'Type']; // Default properties
        this.labelScope = 'selection';
        this.propertyOptionMap = new Map();
        this.phasePropertyOptionMap = new Map();
        this.propertyCatalogLoaded = false;
        this.propertyCatalogPromise = null;
        this.propertyCatalogRetryCount = 0;
        this.propertyCatalogWarmupTimer = null;
        this.phasePropertyName = '';
        this.phaseGroups = [];
        this.phaseTransitionSeconds = 2;
        this.phaseCurrentIndex = -1;
        this.phasePlaybackTimer = null;
        this.phasePlaybackRunning = false;
        this.draggedPhaseIndex = null;

        // Live Labels tracking
        this.objectToMarkupMap = new Map(); // Map objectId -> markupId for live labels
        this.previousSelection = []; // Track previous selection for diff
        this.isProcessingSelection = false; // Prevent duplicate event processing

        // Load user preferences from localStorage
        this.loadFromLocalStorage();

        // IFC Schema-Aware Core Attribute Mappings
        // These map to IfcRoot schema attributes (indices 3, 4, 5, 8 in IFC EXPRESS)
        this.ifcCoreAttributes = {
            // Index 3: GlobalId
            'globalid': ['GlobalId', 'GUID', 'G-UID (IFC)', 'GlobalID', 'Guid'],
            'guid': ['GlobalId', 'GUID', 'G-UID (IFC)', 'GlobalID', 'Guid'],

            // Index 4: OwnerHistory (skip - complex object)

            // Index 5: Name
            'name': ['Name', 'ifcName', 'Product Name', 'Element Name', 'ObjectName'],

            // Index 6: Description  
            'description': ['Description', 'ifcDescription', 'Product Description', 'ObjectDescription'],

            // Index 7: ObjectType (for typed objects)
            'objecttype': ['ObjectType', 'ifcObjectType', 'Type', 'ElementType'],

            // Index 8: Tag (common for identification)
            'tag': ['Tag', 'ifcTag', 'Mark', 'Reference', 'Identifier']
        };

        // Extended property aliases for common Trimble Connect UI names
        this.propertyAliases = {
            'product description': ['Description', 'Name', 'ifcDescription', 'ObjectType'],
            'file name': ['FileName', 'File', 'OriginalFileName'],
            'load bearing': ['LoadBearing', 'IsLoadBearing', 'Structural'],
            'element name': ['Name', 'ifcName', 'Product Name'],
            'element type': ['ObjectType', 'Type', 'PredefinedType', 'ifcObjectType']
        };
        this.version = '2.1.3';
        this.init();
    }

    init() {
        this.log(`🚀 Initializing Attribute Markup Tool v${this.version}`);
        this.setupUI();
        this.connectToWorkspace();
    }

    setupUI() {
        this.setupViewSwitcher();
        this.setupPhaseSequencerUI();

        const propertySelector = document.getElementById('property-names');
        propertySelector.addEventListener('change', () => {
            const selectedValue = propertySelector.value.trim();
            this.propertyNames = selectedValue ? [selectedValue] : [];
            this.log(selectedValue
                ? `Property selected: ${this.getPropertyOptionLabel(selectedValue)}`
                : 'Property selection cleared');
            this.saveToLocalStorage();
        });

        const labelScopeSelector = document.getElementById('label-scope');
        labelScopeSelector.addEventListener('change', () => {
            this.labelScope = labelScopeSelector.value || 'selection';
            this.log(`Label scope selected: ${this.labelScope}`);
            this.saveToLocalStorage();
        });

        // Action buttons
        document.getElementById('apply-btn').addEventListener('click', () => this.applyLabels());
        document.getElementById('clear-btn').addEventListener('click', () => this.clearAllLabels());

        // Bounding box tools
        document.getElementById('dimensions-btn').addEventListener('click', () => this.showDimensions());
        document.getElementById('box-btn').addEventListener('click', () => this.showBoundingBox());

        // Position selector interaction
        this.setupPositionSelectors();

        // Restore previously saved user preferences
        this.restoreUIFromPreferences();

        // Save preferences on change
        document.getElementById('recreate-check').addEventListener('change', () => this.saveToLocalStorage());
        document.getElementById('live-labels-check').addEventListener('change', () => {
            this.saveToLocalStorage();
            const isLive = document.getElementById('live-labels-check').checked;
            this.log(isLive ? '🔴 Live Labels ENABLED' : '⚪ Live Labels DISABLED');
            if (!isLive) {
                // Clear live label tracking when disabled
                this.objectToMarkupMap.clear();
            }
        });

        this.log('UI event listeners attached');
    }

    setupPhaseSequencerUI() {
        const phasePropertySelector = document.getElementById('phase-property-names');
        const transitionSlider = document.getElementById('transition-seconds');
        const prevButton = document.getElementById('phase-prev-btn');
        const playButton = document.getElementById('phase-play-btn');
        const nextButton = document.getElementById('phase-next-btn');
        const phaseCards = document.getElementById('phase-cards');

        if (phasePropertySelector) {
            phasePropertySelector.addEventListener('change', async () => {
                const selectedValue = phasePropertySelector.value.trim();
                this.phasePropertyName = selectedValue;
                this.log(selectedValue
                    ? `4D phase source selected: ${this.getPhasePropertyOptionLabel(selectedValue)}`
                    : '4D phase source cleared');
                await this.loadPhaseSequenceValues();
            });
        }

        if (transitionSlider) {
            transitionSlider.addEventListener('input', () => {
                const nextValue = Number(transitionSlider.value) || 2;
                this.phaseTransitionSeconds = nextValue;
                this.updateTransitionSecondsLabel();
            });
            this.phaseTransitionSeconds = Number(transitionSlider.value) || 2;
            this.updateTransitionSecondsLabel();
        }

        if (prevButton) {
            prevButton.addEventListener('click', async () => {
                this.stopPhasePlayback();
                await this.stepPhaseSequence(-1);
            });
        }

        if (playButton) {
            playButton.addEventListener('click', async () => {
                if (this.phasePlaybackRunning) {
                    this.stopPhasePlayback();
                    return;
                }
                await this.playPhaseSequence();
            });
        }

        if (nextButton) {
            nextButton.addEventListener('click', async () => {
                this.stopPhasePlayback();
                await this.stepPhaseSequence(1);
            });
        }

        if (phaseCards) {
            phaseCards.addEventListener('dragover', (event) => {
                event.preventDefault();
            });

            phaseCards.addEventListener('drop', (event) => {
                event.preventDefault();
                if (this.draggedPhaseIndex === null) return;

                const targetCard = event.target.closest('.phase-card');
                const targetIndex = targetCard
                    ? Number(targetCard.dataset.phaseIndex)
                    : this.phaseGroups.length - 1;

                this.movePhaseGroup(this.draggedPhaseIndex, targetIndex);
            });
        }

        this.renderPhaseCards();
        this.updatePhasePlaybackButton();
    }

    setupViewSwitcher() {
        const tabs = document.querySelectorAll('[data-view-target]');
        const views = document.querySelectorAll('.tool-view');

        if (!tabs.length || !views.length) return;

        const setActiveView = (targetId) => {
            tabs.forEach(tab => {
                const isActive = tab.dataset.viewTarget === targetId;
                tab.classList.toggle('is-active', isActive);
                tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });

            views.forEach(view => {
                const isActive = view.id === targetId;
                view.classList.toggle('is-active', isActive);
                view.hidden = !isActive;
            });
        };

        tabs.forEach(tab => {
            tab.addEventListener('click', () => setActiveView(tab.dataset.viewTarget));
        });

        const defaultTab = document.querySelector('[data-view-target].is-active') || tabs[0];
        setActiveView(defaultTab.dataset.viewTarget);
    }

    updateTransitionSecondsLabel() {
        const label = document.getElementById('transition-seconds-value');
        if (label) {
            label.textContent = `${this.phaseTransitionSeconds.toFixed(1)}s`;
        }
    }

    getPhasePropertyOptionLabel(value) {
        return this.phasePropertyOptionMap.get(value) || this.propertyOptionMap.get(value) || value;
    }

    async loadPhaseSequenceValues() {
        this.stopPhasePlayback();

        if (!this.api) {
            this.setPhaseEmptyState('Connect the tool to Trimble Connect first.');
            return;
        }

        if (!this.phasePropertyName) {
            this.phaseGroups = [];
            this.phaseCurrentIndex = -1;
            this.renderPhaseCards();
            this.setPhaseEmptyState('Select a property to load phase values.');
            return;
        }

        const phaseCards = document.getElementById('phase-cards');
        if (phaseCards) {
            phaseCards.innerHTML = '<p class="phase-empty">Loading phase values...</p>';
        }

        try {
            const modelObjects = await this.api.viewer.getObjects();
            const nextGroups = await this.collectPhaseGroups(modelObjects, this.phasePropertyName);
            this.phaseGroups = nextGroups;
            this.phaseCurrentIndex = -1;
            this.renderPhaseCards();

            if (nextGroups.length === 0) {
                this.setPhaseEmptyState('No values found for the selected property.');
                this.log(`No 4D phase values found for ${this.getPhasePropertyOptionLabel(this.phasePropertyName)}`);
                return;
            }

            this.log(`Loaded ${nextGroups.length} 4D phase value(s) for ${this.getPhasePropertyOptionLabel(this.phasePropertyName)}`);
        } catch (error) {
            this.phaseGroups = [];
            this.phaseCurrentIndex = -1;
            this.renderPhaseCards();
            this.setPhaseEmptyState('Unable to load phase values.');
            this.log(`Error loading 4D phase values: ${error.message}`);
        }
    }

    async collectPhaseGroups(modelObjects, propertyName) {
        const groupedValues = new Map();

        for (const modelGroup of modelObjects || []) {
            const runtimeIds = (modelGroup.objects || [])
                .map(object => object?.id ?? object?.objectRuntimeId)
                .filter(id => Number.isInteger(id));

            if (runtimeIds.length === 0) continue;

            this.log(`4D scan: reading ${runtimeIds.length} object(s) from model ${modelGroup.modelId}`);

            for (let index = 0; index < runtimeIds.length; index += 200) {
                const batchIds = runtimeIds.slice(index, index + 200);
                let objectProperties = (modelGroup.objects || []).slice(index, index + 200);
                const needsHydration = objectProperties.some(objectProps =>
                    !objectProps || (!objectProps.product && !objectProps.properties)
                );

                if (needsHydration) {
                    objectProperties = await this.api.viewer.getObjectProperties(modelGroup.modelId, batchIds);
                }

                for (let objectIndex = 0; objectIndex < batchIds.length; objectIndex += 1) {
                    const runtimeId = batchIds[objectIndex];
                    const objectProps = objectProperties[objectIndex];
                    const rawValue = this.findPropertyValue(objectProps, propertyName);
                    const normalizedValue = this.normalizePhaseValue(rawValue);

                    if (!normalizedValue) continue;

                    if (!groupedValues.has(normalizedValue)) {
                        groupedValues.set(normalizedValue, {
                            id: this.createPhaseGroupId(normalizedValue),
                            value: normalizedValue,
                            count: 0,
                            objectsByModel: new Map()
                        });
                    }

                    const group = groupedValues.get(normalizedValue);
                    group.count += 1;

                    if (!group.objectsByModel.has(modelGroup.modelId)) {
                        group.objectsByModel.set(modelGroup.modelId, []);
                    }

                    group.objectsByModel.get(modelGroup.modelId).push(runtimeId);
                }
            }
        }

        return Array.from(groupedValues.values())
            .sort((left, right) => left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: 'base' }))
            .map(group => ({
                ...group,
                objectSelector: this.buildObjectSelectorFromMap(group.objectsByModel)
            }));
    }

    normalizePhaseValue(value) {
        if (value === null || value === undefined) return '';

        const stringValue = String(value).trim();
        if (!stringValue || stringValue.toLowerCase() === 'no data') return '';

        return stringValue;
    }

    createPhaseGroupId(value) {
        return `phase-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    }

    buildObjectSelectorFromMap(objectsByModel) {
        return {
            modelObjectIds: Array.from(objectsByModel.entries()).map(([modelId, objectRuntimeIds]) => ({
                modelId,
                objectRuntimeIds
            }))
        };
    }

    setPhaseEmptyState(message) {
        const phaseCards = document.getElementById('phase-cards');
        if (!phaseCards) return;

        phaseCards.innerHTML = `<p class="phase-empty">${message}</p>`;
        this.updatePhaseCount();
        this.updateActivePhaseLabel();
    }

    updatePhaseCount() {
        const count = document.getElementById('phase-count');
        if (count) {
            count.textContent = String(this.phaseGroups.length);
        }
    }

    renderPhaseCards() {
        const phaseCards = document.getElementById('phase-cards');
        if (!phaseCards) return;

        this.updatePhaseCount();

        if (!this.phaseGroups.length) {
            phaseCards.innerHTML = '<p class="phase-empty">Select a property to load phase values.</p>';
            this.updatePhasePlaybackButton();
            this.updateActivePhaseLabel();
            return;
        }

        phaseCards.innerHTML = '';

        this.phaseGroups.forEach((group, index) => {
            const card = document.createElement('article');
            card.className = 'phase-card';
            if (index <= this.phaseCurrentIndex && this.phaseCurrentIndex >= 0) {
                card.classList.add('is-active');
            }

            card.draggable = true;
            card.dataset.phaseIndex = String(index);
            card.innerHTML = `
                <p class="phase-card-name">${this.escapeHtml(group.value)} (${group.count})</p>
                <button class="phase-card-remove" type="button" data-remove-phase="${index}" aria-label="Remove phase ${this.escapeHtml(group.value)}">
                    <span class="material-icons-round" aria-hidden="true">close</span>
                </button>
            `;

            card.addEventListener('dragstart', () => {
                this.draggedPhaseIndex = index;
                card.classList.add('is-dragging');
            });

            card.addEventListener('dragend', () => {
                this.draggedPhaseIndex = null;
                card.classList.remove('is-dragging');
            });

            card.addEventListener('dragover', (event) => {
                event.preventDefault();
            });

            card.addEventListener('drop', (event) => {
                event.preventDefault();
                if (this.draggedPhaseIndex === null) return;
                this.movePhaseGroup(this.draggedPhaseIndex, index);
            });

            const removeButton = card.querySelector('[data-remove-phase]');
            removeButton.addEventListener('click', async () => {
                await this.removePhaseGroup(index);
            });

            phaseCards.appendChild(card);
        });

        this.updatePhasePlaybackButton();
        this.updateActivePhaseLabel();
    }

    async removePhaseGroup(index) {
        if (index < 0 || index >= this.phaseGroups.length) return;

        this.stopPhasePlayback();
        const [removed] = this.phaseGroups.splice(index, 1);
        this.log(`Removed 4D phase "${removed.value}" from the sequence`);

        if (this.phaseGroups.length === 0) {
            this.phaseCurrentIndex = -1;
            await this.resetViewerVisibility();
        } else if (this.phaseCurrentIndex >= this.phaseGroups.length) {
            this.phaseCurrentIndex = this.phaseGroups.length - 1;
            await this.applyPhaseVisibility(this.phaseCurrentIndex);
        } else {
            this.phaseCurrentIndex = Math.min(this.phaseCurrentIndex, this.phaseGroups.length - 1);
        }

        this.renderPhaseCards();
    }

    movePhaseGroup(fromIndex, toIndex) {
        if (fromIndex === toIndex || fromIndex === null || toIndex === null) return;
        if (fromIndex < 0 || toIndex < 0) return;
        if (fromIndex >= this.phaseGroups.length || toIndex >= this.phaseGroups.length) return;

        this.stopPhasePlayback();

        const [movedGroup] = this.phaseGroups.splice(fromIndex, 1);
        this.phaseGroups.splice(toIndex, 0, movedGroup);
        this.phaseCurrentIndex = -1;
        this.renderPhaseCards();
        this.log(`Moved 4D phase "${movedGroup.value}" to position ${toIndex + 1}`);
    }

    async playPhaseSequence() {
        if (!this.phaseGroups.length) {
            this.log('4D play ignored: no phases available');
            return;
        }

        this.stopPhasePlayback();
        this.phasePlaybackRunning = true;
        this.phaseCurrentIndex = -1;
        this.updatePhasePlaybackButton();

        await this.applyPhaseVisibility(-1);
        this.scheduleNextPhaseTick(0);
    }

    stopPhasePlayback() {
        if (this.phasePlaybackTimer) {
            clearTimeout(this.phasePlaybackTimer);
            this.phasePlaybackTimer = null;
        }

        this.phasePlaybackRunning = false;
        this.updatePhasePlaybackButton();
    }

    scheduleNextPhaseTick(nextIndex) {
        if (!this.phasePlaybackRunning) return;

        this.phasePlaybackTimer = setTimeout(async () => {
            try {
                if (nextIndex >= this.phaseGroups.length) {
                    this.stopPhasePlayback();
                    return;
                }

                this.phaseCurrentIndex = nextIndex;
                await this.applyPhaseVisibility(this.phaseCurrentIndex);
                this.renderPhaseCards();
                this.scheduleNextPhaseTick(nextIndex + 1);
            } catch (error) {
                this.stopPhasePlayback();
                this.log(`4D playback error: ${error.message}`);
            }
        }, this.phaseTransitionSeconds * 1000);
    }

    async stepPhaseSequence(direction) {
        if (!this.phaseGroups.length) return;

        const nextIndex = Math.max(0, Math.min(this.phaseGroups.length - 1, this.phaseCurrentIndex + direction));
        this.phaseCurrentIndex = nextIndex;
        await this.applyPhaseVisibility(this.phaseCurrentIndex);
        this.renderPhaseCards();
    }

    async applyPhaseVisibility(targetIndex) {
        if (!this.api?.viewer) return;

        if (targetIndex < 0) {
            await this.api.viewer.setObjectState(undefined, { visible: false });
            this.updateActivePhaseLabel();
            this.renderPhaseCards();
            return;
        }

        const cumulativeEntities = this.buildCumulativePhaseEntities(targetIndex);
        await this.api.viewer.setObjectState(undefined, { visible: 'reset' });
        await this.api.viewer.isolateEntities(cumulativeEntities);

        this.log(`4D phase applied up to step ${targetIndex + 1}`);
        this.updateActivePhaseLabel();
    }

    async resetViewerVisibility() {
        if (!this.api?.viewer) return;
        await this.api.viewer.setObjectState(undefined, { visible: 'reset' });
        this.updateActivePhaseLabel();
    }

    updatePhasePlaybackButton() {
        const playButton = document.getElementById('phase-play-btn');
        if (!playButton) return;

        playButton.innerHTML = this.phasePlaybackRunning
            ? '<span class="material-icons-round" aria-hidden="true">pause</span>'
            : '<span class="material-icons-round" aria-hidden="true">play_arrow</span>';
        playButton.setAttribute('aria-label', this.phasePlaybackRunning ? 'Pause sequence' : 'Play sequence');
    }

    updateActivePhaseLabel() {
        const activePhaseLabel = document.getElementById('active-phase-label');
        if (!activePhaseLabel) return;

        if (this.phaseCurrentIndex < 0 || this.phaseCurrentIndex >= this.phaseGroups.length) {
            activePhaseLabel.textContent = 'No active phase';
            return;
        }

        activePhaseLabel.textContent = this.phaseGroups[this.phaseCurrentIndex].value;
    }

    buildCumulativePhaseEntities(targetIndex) {
        const groupedByModel = new Map();

        for (let index = 0; index <= targetIndex; index += 1) {
            const group = this.phaseGroups[index];
            if (!group?.objectsByModel) continue;

            for (const [modelId, objectRuntimeIds] of group.objectsByModel.entries()) {
                if (!groupedByModel.has(modelId)) {
                    groupedByModel.set(modelId, new Set());
                }

                const modelSet = groupedByModel.get(modelId);
                objectRuntimeIds.forEach(objectRuntimeId => modelSet.add(objectRuntimeId));
            }
        }

        return Array.from(groupedByModel.entries()).map(([modelId, entityIds]) => ({
            modelId,
            entityIds: Array.from(entityIds)
        }));
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    setupPositionSelectors() {
        // Get all position boxes
        const longitudinalBoxes = document.querySelectorAll('.position-selector-longitudinal .position-box');
        const sectionBoxes = document.querySelectorAll('.position-selector-section .position-box');

        // Handle longitudinal position selection (radio behavior)
        longitudinalBoxes.forEach(box => {
            box.addEventListener('click', () => {
                longitudinalBoxes.forEach(b => b.classList.remove('active'));
                box.classList.add('active');
                this.log(`Longitudinal position selected: ${box.dataset.position}`);
                this.saveToLocalStorage();
            });
        });

        // Handle section position selection (radio behavior)
        sectionBoxes.forEach(box => {
            box.addEventListener('click', () => {
                sectionBoxes.forEach(b => b.classList.remove('active'));
                box.classList.add('active');
                this.log(`Section position selected: ${box.dataset.position}`);
                this.saveToLocalStorage();
            });
        });

        this.log('Position selectors initialized');
    }

    saveToLocalStorage() {
        try {
            const longitudinal = document.querySelector('.position-selector-longitudinal .position-box.active')?.dataset.position || 'middle';
            const section = document.querySelector('.position-selector-section .position-box.active')?.dataset.position || 'middle-center';
            const recreate = document.getElementById('recreate-check').checked;
            const liveLabels = document.getElementById('live-labels-check').checked;
            const labelScope = document.getElementById('label-scope')?.value || 'selection';
            const clearMode = document.querySelector('input[name="clearMode"]:checked')?.value || 'all';

            const preferences = {
                propertyNames: this.propertyNames,
                labelScope: labelScope,
                longitudinalPosition: longitudinal,
                sectionPosition: section,
                recreate: recreate,
                liveLabels: liveLabels,
                clearMode: clearMode
            };

            localStorage.setItem('attributeMarkupPreferences', JSON.stringify(preferences));
            this.log('💾 Preferences saved to localStorage');
        } catch (error) {
            this.log(`Error saving preferences: ${error.message}`);
        }
    }

    loadFromLocalStorage() {
        try {
            const saved = localStorage.getItem('attributeMarkupPreferences');
            if (!saved) return;

            const preferences = JSON.parse(saved);

            // Restore property names
            if (preferences.propertyNames) {
                this.propertyNames = preferences.propertyNames;
                // Will be set in setupUI after DOM is ready
            }
            if (preferences.labelScope) {
                this.labelScope = preferences.labelScope;
            }

            // Store for later restoration in setupUI
            this.savedPreferences = preferences;
            this.log('📂 Preferences loaded from localStorage');
        } catch (error) {
            this.log(`Error loading preferences: ${error.message}`);
        }
    }

    restoreUIFromPreferences() {
        if (!this.savedPreferences) return;

        try {
            const prefs = this.savedPreferences;

            // Restore property names in textarea
            if (prefs.propertyNames) {
                const propertySelector = document.getElementById('property-names');
                if (propertySelector) {
                    this.pendingPropertySelection = prefs.propertyNames[0] || '';
                    if (this.pendingPropertySelection && this.propertyOptionMap.has(this.pendingPropertySelection)) {
                        propertySelector.value = this.pendingPropertySelection;
                    }
                }
            }

            if (prefs.labelScope) {
                const labelScopeSelector = document.getElementById('label-scope');
                if (labelScopeSelector) {
                    labelScopeSelector.value = prefs.labelScope;
                    this.labelScope = prefs.labelScope;
                }
            }

            // Restore longitudinal position
            if (prefs.longitudinalPosition) {
                document.querySelectorAll('.position-selector-longitudinal .position-box').forEach(box => {
                    box.classList.toggle('active', box.dataset.position === prefs.longitudinalPosition);
                });
            }

            // Restore section position
            if (prefs.sectionPosition) {
                document.querySelectorAll('.position-selector-section .position-box').forEach(box => {
                    box.classList.toggle('active', box.dataset.position === prefs.sectionPosition);
                });
            }

            // Restore recreate checkbox
            if (prefs.recreate !== undefined) {
                const recreateCheck = document.getElementById('recreate-check');
                if (recreateCheck) {
                    recreateCheck.checked = prefs.recreate;
                }
            }

            // Restore live labels checkbox
            if (prefs.liveLabels !== undefined) {
                const liveLabelsCheck = document.getElementById('live-labels-check');
                if (liveLabelsCheck) {
                    liveLabelsCheck.checked = prefs.liveLabels;
                }
            }

            // Restore clear mode
            if (prefs.clearMode) {
                const clearRadio = document.getElementById(`clear-${prefs.clearMode}`);
                if (clearRadio) {
                    clearRadio.checked = true;
                }
            }

            this.log('✅ UI restored from saved preferences');
        } catch (error) {
            this.log(`⚠️ Error restoring preferences: ${error.message}`);
            // Don't throw - allow initialization to continue
        }
    }

    getSelectedPositions() {
        const longitudinal = document.querySelector('.position-selector-longitudinal .position-box.active')?.dataset.position || 'middle';
        const section = document.querySelector('.position-selector-section .position-box.active')?.dataset.position || 'middle-center';
        return { longitudinal, section };
    }

    detectBoundingBoxAxes(bbox) {
        // Calculate dimensions along each axis
        const xLength = Math.abs(bbox.max.x - bbox.min.x);
        const yLength = Math.abs(bbox.max.y - bbox.min.y);
        const zLength = Math.abs(bbox.max.z - bbox.min.z);

        // Find longest axis for longitudinal
        const dimensions = [
            { axis: 'x', length: xLength, min: bbox.min.x, max: bbox.max.x },
            { axis: 'y', length: yLength, min: bbox.min.y, max: bbox.max.y },
            { axis: 'z', length: zLength, min: bbox.min.z, max: bbox.max.z }
        ];

        // Sort by length (descending)
        dimensions.sort((a, b) => b.length - a.length);

        const longitudinalAxis = dimensions[0]; // Longest
        const sectionVertical = dimensions[1];   // Second longest (vertical section)
        const sectionHorizontal = dimensions[2]; // Shortest (horizontal section)

        return { longitudinalAxis, sectionVertical, sectionHorizontal };
    }

    calculateLabelPosition(bbox, longitudinal, section) {
        // Detect dynamic axes based on bounding box dimensions
        const { longitudinalAxis, sectionVertical, sectionHorizontal } = this.detectBoundingBoxAxes(bbox);

        this.log(`📐 Detected axes: Longitudinal=${longitudinalAxis.axis.toUpperCase()} (${longitudinalAxis.length.toFixed(2)}m), Vertical=${sectionVertical.axis.toUpperCase()}, Horizontal=${sectionHorizontal.axis.toUpperCase()}`);

        // Calculate longitudinal position
        let longitudinalValue;
        if (longitudinal === 'start') {
            longitudinalValue = longitudinalAxis.min;
        } else if (longitudinal === 'end') {
            longitudinalValue = longitudinalAxis.max;
        } else { // middle
            longitudinalValue = (longitudinalAxis.min + longitudinalAxis.max) / 2;
        }

        // Parse section position
        const sectionParts = section.split('-');
        const vertical = sectionParts[0]; // top, middle, bottom
        const horizontal = sectionParts[1]; // left, center, right

        // Calculate vertical section position
        let verticalValue;
        if (vertical === 'top') {
            verticalValue = sectionVertical.max;
        } else if (vertical === 'bottom') {
            verticalValue = sectionVertical.min;
        } else { // middle
            verticalValue = (sectionVertical.min + sectionVertical.max) / 2;
        }

        // Calculate horizontal section position
        let horizontalValue;
        if (horizontal === 'left') {
            horizontalValue = sectionHorizontal.min;
        } else if (horizontal === 'right') {
            horizontalValue = sectionHorizontal.max;
        } else { // center
            horizontalValue = (sectionHorizontal.min + sectionHorizontal.max) / 2;
        }

        // Map back to XYZ coordinates
        const position = { x: 0, y: 0, z: 0 };
        position[longitudinalAxis.axis] = longitudinalValue;
        position[sectionVertical.axis] = verticalValue;
        position[sectionHorizontal.axis] = horizontalValue;

        return position;
    }

    async connectToWorkspace() {
        try {
            this.log('Connecting to Trimble Connect Workspace API...');
            this.api = await TrimbleConnectWorkspace.connect(
                window.parent,
                (event, data) => this.handleEvent(event, data)
            );

            this.log('✓ Connected successfully!');
            this.updateStatus('✅ Connected! Select elements in 3D view, then click "Create Labels"', 'success');
            this.schedulePropertyCatalogWarmup();
            this.ensurePropertyCatalogLoaded();

        } catch (error) {
            this.log(`ERROR: ${error.message}`);
            this.updateStatus('Connection failed. Make sure to load this in Trimble Connect.', 'warning');
        }
    }
    async handleEvent(event, data) {
        if (event === 'viewer.onModelStateChanged') {
            this.log('📦 Model state changed, refreshing property catalog...');
            this.propertyCatalogLoaded = false;
            this.schedulePropertyCatalogWarmup();
            this.ensurePropertyCatalogLoaded(true);
            return;
        }

        // Listen for selection changes
        if (event === 'viewer.onSelectionChanged') {
            await this.updateSelectionCount();
            if (!this.propertyCatalogLoaded) {
                this.ensurePropertyCatalogLoaded(false);
            }

            // Check if Live Labels mode is enabled
            const liveLabelsEnabled = document.getElementById('live-labels-check')?.checked;
            if (!liveLabelsEnabled) return;

            // Skip if already processing (event fires multiple times)
            if (this.isProcessingSelection) {
                this.log('⏭️ Skipping duplicate selection event');
                return;
            }
            this.isProcessingSelection = true;

            try {
                // Get current selection
                const selection = await this.api.viewer.getSelection();
                const currentObjectIds = new Set();

                // Collect all selected object IDs
                for (const modelSelection of selection) {
                    modelSelection.objectRuntimeIds.forEach(id => currentObjectIds.add(id));
                }

                // If selection is empty, remove all live labels
                if (currentObjectIds.size === 0 && this.objectToMarkupMap.size > 0) {
                    const allTrackedObjects = Array.from(this.objectToMarkupMap.keys());
                    await this.removeLabelsForObjects(allTrackedObjects);
                    return;
                }

                // Find newly selected objects (need to add labels)
                const newlySelected = [];
                for (const objId of currentObjectIds) {
                    if (!this.objectToMarkupMap.has(objId)) {
                        newlySelected.push(objId);
                    }
                }

                // Find deselected objects (need to remove labels)
                const deselected = [];
                for (const objId of this.objectToMarkupMap.keys()) {
                    if (!currentObjectIds.has(objId)) {
                        deselected.push(objId);
                    }
                }

                // Remove labels for deselected objects
                if (deselected.length > 0) {
                    await this.removeLabelsForObjects(deselected);
                }

                // Add labels for newly selected objects
                if (newlySelected.length > 0 && selection.length > 0) {
                    await this.addLabelsForObjects(selection, newlySelected);
                }

            } catch (error) {
                this.log(`❌ Live Labels error: ${error.message}`);
            } finally {
                this.isProcessingSelection = false;
            }
        }
    }

    async updateSelectionCount() {
        try {
            const selection = await this.api.viewer.getSelection();
            const totalCount = selection.reduce((sum, model) => sum + model.objectRuntimeIds.length, 0);
            document.getElementById('selected-count').textContent = totalCount;

            if (totalCount > 0) {
                this.log(`📌 Selection updated: ${totalCount} element(s) selected`);
            }
        } catch (error) {
            this.log(`Error getting selection: ${error.message}`);
        }
    }

    async applyLabels() {
        try {
            this.log(`📝 Preparing labels for scope: ${this.labelScope}`);

            if (!this.propertyNames || this.propertyNames.length === 0) {
                this.updateStatus('⚠️ Select an attribute or property before creating labels.', 'warning');
                this.log('No property selected for labeling');
                return;
            }

            // Check Recreate mode
            const recreateMode = document.getElementById('recreate-check').checked;

            if (recreateMode) {
                this.log('🔄 Recreate mode: Clearing existing labels first...');
                await this.clearMarkupsOnly();
            } else {
                this.log('➕ Incremental mode: Appending new labels to existing ones...');
            }

            const targetSelections = await this.getTargetSelectionsForLabels();

            if (!targetSelections || targetSelections.length === 0) {
                const warningMessage = this.labelScope === 'all'
                    ? '⚠️ No visible model objects found in the 3D view.'
                    : '⚠️ No elements selected. Select elements in the 3D view first.';
                this.updateStatus(warningMessage, 'warning');
                this.log(this.labelScope === 'all' ? 'No visible objects found' : 'No selection found');
                return;
            }

            const textMarkups = [];

            // Process each model's target objects
            for (const modelSelection of targetSelections) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                this.log(`Processing ${objectIds.length} objects from model ${modelId}`);

                // Get properties for all selected objects in this model
                const properties = await this.api.viewer.getObjectProperties(modelId, objectIds);

                // Create markup for each object
                for (let i = 0; i < objectIds.length; i++) {
                    const objectId = objectIds[i];
                    const objectProps = properties[i];

                    const markup = await this.createTextMarkup(modelId, objectId, objectProps);
                    if (markup) {
                        textMarkups.push(markup);
                    }
                }
            }

            if (textMarkups.length === 0) {
                this.updateStatus('⚠️ No markups created. Check debug log.', 'warning');
                return;
            }

            // Add all text markups to the viewer
            const result = await this.api.markup.addTextMarkup(textMarkups);
            this.markupIds = result.map(m => m.id);

            document.getElementById('labels-count').textContent = result.length;

            this.log(`✅ Created ${result.length} text markups in 3D viewer!`);
            this.updateStatus(`✅ ${result.length} label(s) displayed in 3D view`, 'success');

        } catch (error) {
            this.log(`❌ Error: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async getTargetSelectionsForLabels() {
        if (this.labelScope === 'all') {
            const modelObjects = await this.api.viewer.getObjects();
            const allVisibleObjects = [];

            for (const modelGroup of modelObjects || []) {
                const objectRuntimeIds = (modelGroup.objects || [])
                    .map(object => object?.id ?? object?.objectRuntimeId)
                    .filter(id => Number.isInteger(id));

                if (objectRuntimeIds.length > 0) {
                    allVisibleObjects.push({
                        modelId: modelGroup.modelId,
                        objectRuntimeIds
                    });
                }
            }

            return allVisibleObjects;
        }

        return this.api.viewer.getSelection();
    }

    async createTextMarkup(modelId, objectId, properties) {
        try {
            // Get element position from bounding box
            const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, [objectId]);

            if (!bboxes || bboxes.length === 0) {
                this.log(`No bounding box for object ${objectId}`);
                return null;
            }

            const bbox = bboxes[0].boundingBox;

            // Get selected positions from UI
            const { longitudinal, section } = this.getSelectedPositions();

            // Calculate position based on user selection
            const position = this.calculateLabelPosition(bbox, longitudinal, section);

            // Format label text based on properties
            const labelText = this.extractProperties(properties);

            if (!labelText || labelText === 'No data') {
                this.log(`No displayable properties for object ${objectId}`);
                return null;
            }

            // Create TextMarkup object
            const textMarkup = {
                start: {
                    positionX: position.x * 1000, // Convert m to mm
                    positionY: position.y * 1000,
                    positionZ: position.z * 1000,
                    modelId: modelId,
                    objectId: objectId
                },
                end: {
                    positionX: position.x * 1000 + 200, // Leader line offset
                    positionY: position.y * 1000,
                    positionZ: position.z * 1000 + 100,
                    modelId: modelId,
                    objectId: objectId
                },
                text: labelText,
                color: { r: 201, g: 20, b: 45, a: 255 } // Typsa red
            };

            this.log(`Markup prepared for object ${objectId}: "${labelText.substring(0, 50)}..."`);

            // Attach objectId for Live Labels tracking
            textMarkup.objectId = objectId;

            return textMarkup;

        } catch (error) {
            this.log(`Error creating markup for object ${objectId}: ${error.message}`);
            return null;
        }
    }

    extractProperties(objectProps) {
        const lines = [];

        // DEBUG: Log all available properties for this object
        this.logAvailableProperties(objectProps);

        // Try to extract each requested property
        for (const propName of this.propertyNames) {
            const value = this.findPropertyValue(objectProps, propName);
            if (value !== null && value !== undefined) {
                // Display only the value, not the property name
                lines.push(String(value));
            }
        }

        return lines.length > 0 ? lines.join('\n') : 'No data';
    }

    logAvailableProperties(objectProps) {
        // Log once per object to avoid spam
        if (this.debuggedObject === objectProps.id) return;
        this.debuggedObject = objectProps.id;

        this.log(`🔍 Properties available for object ${objectProps.id}:`);
        this.log(`  - class: ${objectProps.class}`);
        this.log(`  - product.name: ${objectProps.product?.name}`);

        if (objectProps.properties) {
            objectProps.properties.forEach((pset, idx) => {
                this.log(`  📦 PropertySet[${idx}]: "${pset.name}"`);
                if (pset.properties) {
                    // Handle both object and array property structures
                    const props = this.normalizeProperties(pset.properties);
                    Object.entries(props).forEach(([key, value]) => {
                        this.log(`      - "${key}" = "${value}"`);
                    });
                }
            });
        } else {
            this.log(`  ⚠️ No property sets found`);
        }
    }

    normalizeProperties(properties) {
        // Properties might be an object or an array of property objects
        if (Array.isArray(properties)) {
            // Array format: [{ name: "PropName", value: "PropValue" }, ...]
            const normalized = {};
            properties.forEach(prop => {
                if (prop && typeof prop === 'object') {
                    // Try multiple possible name fields
                    const name = prop.name || prop.Name || prop.key || prop.Key || prop.propertyName;
                    // Try multiple possible value fields
                    const value = prop.value !== undefined ? prop.value :
                        prop.Value !== undefined ? prop.Value :
                            prop.val !== undefined ? prop.val :
                                prop.nominalValue !== undefined ? prop.nominalValue :
                                    prop.NominalValue !== undefined ? prop.NominalValue : null;

                    if (name && value !== null && value !== undefined) {
                        normalized[name] = value;
                    }
                }
            });
            return normalized;
        } else if (typeof properties === 'object') {
            // Object format: might have nested objects
            const normalized = {};
            for (const [key, val] of Object.entries(properties)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    // Nested object, try to extract value from common property structures
                    let value = val.value || val.Value || val.val ||
                        val.nominalValue || val.NominalValue;

                    // If still no value, try to stringify the object intelligently
                    if (value === undefined || value === null) {
                        // Check if it has a type and value field (common IFC structure)
                        if (val.type && val.value !== undefined) {
                            value = val.value;
                        } else {
                            // Last resort: JSON stringify
                            value = JSON.stringify(val);
                        }
                    }

                    normalized[key] = value;
                } else {
                    normalized[key] = val;
                }
            }
            return normalized;
        }
        return properties;
    }

    findPropertyValue(objectProps, propertyName) {
        const descriptor = this.parsePropertyDescriptor(propertyName);
        if (descriptor) {
            return this.findPropertyValueByDescriptor(objectProps, descriptor);
        }

        const nameLower = propertyName.toLowerCase();
        const nameNoSpaces = propertyName.replace(/\s+/g, '').toLowerCase();

        // STEP 1: Check if this is a core IFC attribute (schema-aware)
        if (this.ifcCoreAttributes[nameLower] || this.ifcCoreAttributes[nameNoSpaces]) {
            const coreAttrResult = this.findCoreIfcAttribute(objectProps, propertyName);
            if (coreAttrResult !== null) {
                return coreAttrResult;
            }
        }

        // STEP 2: Check Product object for direct attributes
        const productResult = this.findInProductObject(objectProps, propertyName);
        if (productResult !== null) {
            return productResult;
        }

        // STEP 3: Build search list with aliases
        const searchNames = [propertyName];
        if (this.propertyAliases && this.propertyAliases[nameLower]) {
            searchNames.push(...this.propertyAliases[nameLower]);
            this.log(`🔄 Using aliases for "${propertyName}": ${this.propertyAliases[nameLower].join(', ')}`);
        }

        // Search for each possible name (original + aliases)
        for (const searchName of searchNames) {
            const result = this.searchInPropertySets(objectProps, searchName);
            if (result !== null) {
                return result;
            }
        }

        this.log(`✗ Property "${propertyName}" not found in any property set`);
        return null;
    }

    parsePropertyDescriptor(propertyName) {
        if (!propertyName || !propertyName.includes('::')) return null;

        const [type, ...parts] = propertyName.split('::');
        if (type === 'meta' && parts.length >= 1) {
            return { type, key: parts.join('::') };
        }
        if ((type === 'product' || type === 'core') && parts.length >= 1) {
            return { type, key: parts.join('::') };
        }
        if (type === 'pset' && parts.length >= 2) {
            return {
                type,
                setName: parts[0],
                key: parts.slice(1).join('::')
            };
        }
        return null;
    }

    findPropertyValueByDescriptor(objectProps, descriptor) {
        if (descriptor.type === 'meta') {
            const metaValue = objectProps?.[descriptor.key];
            return metaValue !== undefined && metaValue !== null ? this.formatValue(metaValue) : null;
        }

        if (descriptor.type === 'product' || descriptor.type === 'core') {
            return this.findInProductByKey(objectProps, descriptor.key);
        }

        if (descriptor.type === 'pset') {
            return this.findInSpecificPropertySet(objectProps, descriptor.setName, descriptor.key);
        }

        return null;
    }

    findInProductByKey(objectProps, propertyKey) {
        if (!objectProps?.product) return null;

        const product = objectProps.product;
        const exactValue = product[propertyKey];
        if (exactValue !== undefined && exactValue !== null && exactValue !== '') {
            this.log(`✓ Found in Product.${propertyKey}: "${exactValue}"`);
            return this.formatValue(exactValue);
        }

        const matchingEntry = Object.entries(product).find(([key, value]) =>
            key.toLowerCase() === propertyKey.toLowerCase() && value !== undefined && value !== null && value !== ''
        );

        if (matchingEntry) {
            this.log(`✓ Found in Product.${matchingEntry[0]}: "${matchingEntry[1]}"`);
            return this.formatValue(matchingEntry[1]);
        }

        return null;
    }

    findInSpecificPropertySet(objectProps, setName, propertyKey) {
        if (!objectProps?.properties) return null;

        const targetSet = setName.toLowerCase();
        const targetProperty = propertyKey.toLowerCase();
        const targetPropertyNoSpaces = propertyKey.replace(/\s+/g, '').toLowerCase();

        for (const pset of objectProps.properties) {
            const currentSetName = (pset.set || pset.name || '').trim();
            if (currentSetName.toLowerCase() !== targetSet) continue;
            if (!pset.properties) continue;

            const props = this.normalizeProperties(pset.properties);
            for (const [key, value] of Object.entries(props)) {
                const keyNoSpaces = key.replace(/\s+/g, '').toLowerCase();
                if (key.toLowerCase() === targetProperty || keyNoSpaces === targetPropertyNoSpaces) {
                    this.log(`✓ Found exact match in "${currentSetName}": "${key}" = "${value}"`);
                    return this.formatValue(value);
                }
            }
        }

        return null;
    }

    /**
     * Find core IFC attributes (Name, Description, Tag, ObjectType)
     * These are from IfcRoot schema and may be stored differently
     */
    findCoreIfcAttribute(objectProps, propertyName) {
        const nameLower = propertyName.toLowerCase();
        const nameNoSpaces = propertyName.replace(/\s+/g, '').toLowerCase();

        // Get all possible attribute names
        const attributeVariations = this.ifcCoreAttributes[nameLower] || this.ifcCoreAttributes[nameNoSpaces] || [];

        this.log(`🏛️ Checking core IFC attributes for "${propertyName}": ${attributeVariations.join(', ')}`);

        // Check in Product object first
        if (objectProps.product) {
            for (const attrName of attributeVariations) {
                const attrLower = attrName.toLowerCase();
                const value = objectProps.product[attrName] || objectProps.product[attrLower];
                if (value) {
                    this.log(`✓ Found in Product object: "${attrName}" = "${value}"`);
                    return this.formatValue(value);
                }
            }
        }

        // Check in properties with null/empty pset (core IFC attributes often have no pset)
        if (objectProps.properties) {
            for (const pset of objectProps.properties) {
                if (!pset.name || pset.name === '' || pset.name === 'Product' || pset.name === 'System') {
                    const props = this.normalizeProperties(pset.properties);

                    for (const attrName of attributeVariations) {
                        const value = props[attrName];
                        if (value) {
                            this.log(`✓ Found core attribute in "${pset.name || 'null pset'}": "${attrName}" = "${value}"`);
                            return this.formatValue(value);
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Search in the Product object for direct properties
     */
    findInProductObject(objectProps, propertyName) {
        if (!objectProps.product) return null;

        const nameLower = propertyName.toLowerCase();
        const product = objectProps.product;

        // Try direct property access
        const directValue = product[propertyName] || product[nameLower];
        if (directValue) {
            this.log(`✓ Found in Product.${propertyName}: "${directValue}"`);
            return this.formatValue(directValue);
        }

        // Try common product properties
        const productProps = {
            'name': product.name,
            'description': product.description,
            'objecttype': product.objectType || product.ObjectType,
            'type': product.type || product.Type
        };

        if (productProps[nameLower]) {
            this.log(`✓ Found in Product.${nameLower}: "${productProps[nameLower]}"`);
            return this.formatValue(productProps[nameLower]);
        }

        return null;
    }

    searchInPropertySets(objectProps, propertyName) {
        const nameLower = propertyName.toLowerCase();
        const nameNoSpaces = propertyName.replace(/\s+/g, '').toLowerCase();

        // Search in ALL property sets
        if (objectProps.properties) {
            for (const pset of objectProps.properties) {
                if (!pset.properties) continue;

                // Normalize the properties structure
                const props = this.normalizeProperties(pset.properties);

                // Try exact match first (case-insensitive)
                for (const [key, value] of Object.entries(props)) {
                    if (key.toLowerCase() === nameLower) {
                        this.log(`✓ Found exact match in "${pset.name}": "${key}" = "${value}"`);
                        return this.formatValue(value);
                    }
                }

                // Try exact match without spaces
                for (const [key, value] of Object.entries(props)) {
                    const keyNoSpaces = key.replace(/\s+/g, '').toLowerCase();
                    if (keyNoSpaces === nameNoSpaces) {
                        this.log(`✓ Found exact match (ignoring spaces) in "${pset.name}": "${key}" = "${value}"`);
                        return this.formatValue(value);
                    }
                }

                // Try partial match - ONLY if property name contains search term
                // (not if search term contains property name - that was the bug!)
                for (const [key, value] of Object.entries(props)) {
                    const keyLower = key.toLowerCase();
                    const keyNoSpaces = key.replace(/\s+/g, '').toLowerCase();

                    // Property name must contain the search term
                    if (keyLower.includes(nameLower) || keyNoSpaces.includes(nameNoSpaces)) {
                        this.log(`✓ Found partial match in "${pset.name}": "${key}" = "${value}"`);
                        return this.formatValue(value);
                    }
                }
            }
        }

        return null;
    }

    formatValue(value) {
        if (typeof value === 'number') {
            return value.toFixed(2);
        }
        return String(value);
    }

    async clearMarkupsOnly() {
        try {
            let totalRemoved = 0;

            // Clear text markups (from Create button)
            if (this.markupIds.length > 0) {
                await this.api.markup.removeMarkups(this.markupIds);
                this.log(`🗑️ Removed ${this.markupIds.length} text markup(s)`);
                totalRemoved += this.markupIds.length;
                this.markupIds = [];
            }

            // Clear point markups
            if (this.pointMarkupIds.length > 0) {
                await this.api.markup.removeMarkups(this.pointMarkupIds);
                this.log(`🗑️ Removed ${this.pointMarkupIds.length} point markup(s)`);
                totalRemoved += this.pointMarkupIds.length;
                this.pointMarkupIds = [];
            }

            // Clear line markups (bounding boxes)
            if (this.lineMarkupIds.length > 0) {
                await this.api.markup.removeMarkups(this.lineMarkupIds);
                this.log(`🗑️ Removed ${this.lineMarkupIds.length} line markup(s)`);
                totalRemoved += this.lineMarkupIds.length;
                this.lineMarkupIds = [];
            }

            // Clear measurement markups
            if (this.measurementMarkupIds.length > 0) {
                await this.api.markup.removeMarkups(this.measurementMarkupIds);
                this.log(`🗑️ Removed ${this.measurementMarkupIds.length} measurement markup(s)`);
                totalRemoved += this.measurementMarkupIds.length;
                this.measurementMarkupIds = [];
            }

            // Clear Live Labels
            if (this.objectToMarkupMap.size > 0) {
                const liveMarkupIds = Array.from(this.objectToMarkupMap.values());
                await this.api.markup.removeMarkups(liveMarkupIds);
                this.log(`🗑️ Removed ${liveMarkupIds.length} live label(s)`);
                totalRemoved += liveMarkupIds.length;
                this.objectToMarkupMap.clear();
            }

            if (totalRemoved > 0) {
                this.log(`✅ Total removed: ${totalRemoved} markup(s)`);
            } else {
                this.log('No markups to clear');
            }

            document.getElementById('labels-count').textContent = '0';

        } catch (error) {
            this.log(`❌ Error clearing markups: ${error.message}`);
        }
    }

    async clearAllLabels() {
        // Always clear all markups (selective clearing not possible with API)
        await this.clearMarkupsOnly();
        this.log('All markups cleared');
        this.updateStatus('All markups cleared', 'info');
    }

    async addLabelsForObjects(selection, objectIds) {
        try {
            const textMarkups = [];

            // Process each model
            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;

                // Filter to only process the newly selected objects
                const objectsToProcess = modelSelection.objectRuntimeIds.filter(id => objectIds.includes(id));
                if (objectsToProcess.length === 0) continue;

                // Get properties for these objects
                const properties = await this.api.viewer.getObjectProperties(modelId, objectsToProcess);

                // Create markup for each object
                for (let i = 0; i < objectsToProcess.length; i++) {
                    const objectId = objectsToProcess[i];
                    const objectProps = properties[i];

                    const markup = await this.createTextMarkup(modelId, objectId, objectProps);
                    if (markup) {
                        textMarkups.push(markup);
                    }
                }
            }

            if (textMarkups.length > 0) {
                // Add all text markups to the viewer
                const addedMarkups = await this.api.markup.addTextMarkup(textMarkups);

                this.log(`📊 addTextMarkup returned: ${JSON.stringify(addedMarkups).substring(0, 150)}`);

                // Track the object-to-markup mappings
                for (let i = 0; i < textMarkups.length; i++) {
                    const markup = textMarkups[i];
                    const markupId = addedMarkups[i].id;

                    // Extract objectId from the markup (it was attached during creation)
                    if (markup.objectId) {
                        this.objectToMarkupMap.set(markup.objectId, markupId);
                        this.log(`📊 STORE obj${markup.objectId}->markup${markupId}`);
                    }
                }

                this.log(`🔴 Live: Added ${addedMarkups.length} label(s)`);
            }
        } catch (error) {
            this.log(`❌ Error adding live labels: ${error.message}`);
        }
    }

    async removeLabelsForObjects(objectIds) {
        try {
            const markupIdsToRemove = [];

            for (const objectId of objectIds) {
                const markupId = this.objectToMarkupMap.get(objectId);
                this.log(`📊 GET obj${objectId}->markup${markupId}`);
                if (markupId) {
                    markupIdsToRemove.push(markupId);
                    this.objectToMarkupMap.delete(objectId);
                }
            }

            if (markupIdsToRemove.length > 0) {
                await this.api.markup.removeMarkups(markupIdsToRemove);
                this.log(`⚪ Live: Removed ${markupIdsToRemove.length} label(s)`);
            }
        } catch (error) {
            this.log(`❌ Error removing live labels: ${error.message}`);
        }
    }

    async markZMax() {
        try {
            this.log('📍 Creating top point mark...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected', 'warning');
                return;
            }

            const pointMarkups = [];

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (const bboxData of bboxes) {
                    const bbox = bboxData.boundingBox;
                    // Top point = highest Z coordinate
                    const topPoint = {
                        positionX: (bbox.min.x + bbox.max.x) / 2 * 1000, // Convert to mm
                        positionY: (bbox.min.y + bbox.max.y) / 2 * 1000,
                        positionZ: bbox.max.z * 1000, // Highest Z
                        modelId: modelId,
                        objectId: bboxData.objectRuntimeId
                    };

                    pointMarkups.push({ start: topPoint });
                }
            }

            const result = await this.api.markup.addSinglePointMarkups(pointMarkups);
            this.pointMarkupIds.push(...result.map(m => m.id));

            this.log(`✅ Created ${result.length} top point mark(s)`);
            this.updateStatus(`✅ ${result.length} top mark(s) created`, 'success');

        } catch (error) {
            this.log(`❌ Error creating top mark: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async markZMin() {
        try {
            this.log('📍 Creating bottom point mark...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected', 'warning');
                return;
            }

            const pointMarkups = [];

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (const bboxData of bboxes) {
                    const bbox = bboxData.boundingBox;
                    // Bottom point = lowest Z coordinate
                    const bottomPoint = {
                        positionX: (bbox.min.x + bbox.max.x) / 2 * 1000, // Convert to mm
                        positionY: (bbox.min.y + bbox.max.y) / 2 * 1000,
                        positionZ: bbox.min.z * 1000, // Lowest Z
                        modelId: modelId,
                        objectId: bboxData.objectRuntimeId
                    };

                    pointMarkups.push({ start: bottomPoint });
                }
            }

            const result = await this.api.markup.addSinglePointMarkups(pointMarkups);
            this.pointMarkupIds.push(...result.map(m => m.id));

            this.log(`✅ Created ${result.length} bottom point mark(s)`);
            this.updateStatus(`✅ ${result.length} bottom mark(s) created`, 'success');

        } catch (error) {
            this.log(`❌ Error creating bottom mark: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async markInCenter() {
        if (!this.api) {
            this.updateStatus('Not connected to Trimble Connect', 'warning');
            return;
        }

        try {
            this.log('🎯 Creating labels at center positions...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected. Please select elements first.', 'warning');
                return;
            }

            const markups = [];
            let successCount = 0;

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                this.log(`Processing ${objectIds.length} objects from model ${modelId}...`);

                // Get properties for all objects
                const objectPropsArray = await this.api.viewer.getObjectProperties(modelId, objectIds);

                // Get bounding boxes for center positions
                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (let i = 0; i < objectIds.length; i++) {
                    const objectId = objectIds[i];
                    const objectProps = objectPropsArray[i];
                    const bboxData = bboxes[i];

                    if (!bboxData || !bboxData.boundingBox) {
                        this.log(`No bounding box for object ${objectId}, skipping...`);
                        continue;
                    }

                    const bbox = bboxData.boundingBox;

                    // Calculate center position
                    const centerPosition = {
                        x: (bbox.min.x + bbox.max.x) / 2,
                        y: (bbox.min.y + bbox.max.y) / 2,
                        z: (bbox.min.z + bbox.max.z) / 2
                    };

                    // Extract properties to display
                    const labelText = this.extractProperties(objectProps);

                    if (!labelText || labelText === 'No data') {
                        this.log(`No properties found for object ${objectId}, skipping...`);
                        continue;
                    }

                    // Create TextMarkup at center
                    const textMarkup = {
                        start: {
                            positionX: centerPosition.x * 1000, // Convert m to mm
                            positionY: centerPosition.y * 1000,
                            positionZ: centerPosition.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        end: {
                            positionX: centerPosition.x * 1000 + 200, // Leader line offset
                            positionY: centerPosition.y * 1000,
                            positionZ: centerPosition.z * 1000 + 100,
                            modelId: modelId,
                            objectId: objectId
                        },
                        text: labelText,
                        color: { r: 201, g: 20, b: 45, a: 255 } // Typsa red
                    };

                    markups.push(textMarkup);
                    successCount++;
                }
            }

            if (markups.length === 0) {
                this.updateStatus('No labels could be created. Check property names.', 'warning');
                return;
            }

            // Add all markups to viewer
            const results = await this.api.markup.addTextMarkup(markups);
            this.markupIds.push(...results.map(m => m.id));

            this.log(`✅ Successfully created ${results.length} center labels`);
            this.updateStatus(`✅ Created ${results.length} center labels`, 'success');
            document.getElementById('labels-count').textContent = this.markupIds.length;

        } catch (error) {
            this.log(`❌ Error creating center labels: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async showDimensions() {
        try {
            this.log('📏 Creating bounding box dimensions...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected', 'warning');
                return;
            }

            const measurements = [];

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (const bboxData of bboxes) {
                    const bbox = bboxData.boundingBox;
                    const objectId = bboxData.objectRuntimeId;

                    // Calculate center points for dimension lines
                    const centerX = (bbox.min.x + bbox.max.x) / 2 * 1000;
                    const centerY = (bbox.min.y + bbox.max.y) / 2 * 1000;
                    const centerZ = (bbox.min.z + bbox.max.z) / 2 * 1000;

                    // Dimension 1: Length (X-axis) - along bottom front edge
                    measurements.push({
                        start: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        end: {
                            positionX: bbox.max.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineStart: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: bbox.max.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 0, g: 99, b: 163, a: 1 } // Trimble blue
                    });

                    // Dimension 2: Width (Y-axis) - along bottom left edge
                    measurements.push({
                        start: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        end: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.max.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineStart: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.max.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 0, g: 99, b: 163, a: 1 } // Trimble blue
                    });

                    // Dimension 3: Height (Z-axis) - along front left edge
                    measurements.push({
                        start: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        end: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.max.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineStart: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: bbox.min.x * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: bbox.max.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 0, g: 99, b: 163, a: 1 } // Trimble blue
                    });
                }
            }

            const result = await this.api.markup.addMeasurementMarkups(measurements);
            this.measurementMarkupIds.push(...result.map(m => m.id));

            const elementsCount = measurements.length / 3;
            this.log(`✅ Created 3 dimension measurements for ${elementsCount} element(s)`);
            this.updateStatus(`✅ Dimensions displayed for ${elementsCount} element(s)`, 'success');

        } catch (error) {
            this.log(`❌ Error creating dimensions: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async dimensionCenter() {
        try {
            this.log('📐 Creating centerline dimensions...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected', 'warning');
                return;
            }

            const measurements = [];

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (const bboxData of bboxes) {
                    const bbox = bboxData.boundingBox;
                    const objectId = bboxData.objectRuntimeId;

                    // Calculate center points
                    const centerX = (bbox.min.x + bbox.max.x) / 2;
                    const centerY = (bbox.min.y + bbox.max.y) / 2;
                    const centerZ = (bbox.min.z + bbox.max.z) / 2;

                    // Dimension 1: Length along centerline (X-axis through center)
                    measurements.push({
                        start: {
                            positionX: bbox.min.x * 1000,
                            positionY: centerY * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: bbox.max.x * 1000,
                            position2Y: centerY * 1000,
                            position2Z: centerZ * 1000
                        },
                        end: {
                            positionX: bbox.max.x * 1000,
                            positionY: centerY * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: bbox.min.x * 1000,
                            position2Y: centerY * 1000,
                            position2Z: centerZ * 1000
                        },
                        mainLineStart: {
                            positionX: bbox.min.x * 1000,
                            positionY: centerY * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: bbox.max.x * 1000,
                            positionY: centerY * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 255, g: 140, b: 0, a: 1 } // Orange color for distinction
                    });

                    // Dimension 2: Width along centerline (Y-axis through center)
                    measurements.push({
                        start: {
                            positionX: centerX * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: centerX * 1000,
                            position2Y: bbox.max.y * 1000,
                            position2Z: centerZ * 1000
                        },
                        end: {
                            positionX: centerX * 1000,
                            positionY: bbox.max.y * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: centerX * 1000,
                            position2Y: bbox.min.y * 1000,
                            position2Z: centerZ * 1000
                        },
                        mainLineStart: {
                            positionX: centerX * 1000,
                            positionY: bbox.min.y * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: centerX * 1000,
                            positionY: bbox.max.y * 1000,
                            positionZ: centerZ * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 255, g: 140, b: 0, a: 1 } // Orange color
                    });

                    // Dimension 3: Height along centerline (Z-axis through center)
                    measurements.push({
                        start: {
                            positionX: centerX * 1000,
                            positionY: centerY * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: centerX * 1000,
                            position2Y: centerY * 1000,
                            position2Z: bbox.max.z * 1000
                        },
                        end: {
                            positionX: centerX * 1000,
                            positionY: centerY * 1000,
                            positionZ: bbox.max.z * 1000,
                            modelId: modelId,
                            objectId: objectId,
                            type: 'lineSegment',
                            position2X: centerX * 1000,
                            position2Y: centerY * 1000,
                            position2Z: bbox.min.z * 1000
                        },
                        mainLineStart: {
                            positionX: centerX * 1000,
                            positionY: centerY * 1000,
                            positionZ: bbox.min.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        mainLineEnd: {
                            positionX: centerX * 1000,
                            positionY: centerY * 1000,
                            positionZ: bbox.max.z * 1000,
                            modelId: modelId,
                            objectId: objectId
                        },
                        color: { r: 255, g: 140, b: 0, a: 1 } // Orange color
                    });
                }
            }

            const result = await this.api.markup.addMeasurementMarkups(measurements);
            this.measurementMarkupIds.push(...result.map(m => m.id));

            const elementsCount = measurements.length / 3;
            this.log(`✅ Created 3 centerline dimensions for ${elementsCount} element(s)`);
            this.updateStatus(`✅ Centerline dimensions for ${elementsCount} element(s)`, 'success');

        } catch (error) {
            this.log(`❌ Error creating centerline dimensions: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    async showBoundingBox() {
        try {
            this.log('📦 Creating bounding box wireframe...');
            const selection = await this.api.viewer.getSelection();

            if (!selection || selection.length === 0) {
                this.updateStatus('⚠️ No elements selected', 'warning');
                return;
            }

            const lineMarkups = [];

            for (const modelSelection of selection) {
                const modelId = modelSelection.modelId;
                const objectIds = modelSelection.objectRuntimeIds;

                const bboxes = await this.api.viewer.getObjectBoundingBoxes(modelId, objectIds);

                for (const bboxData of bboxes) {
                    const bbox = bboxData.boundingBox;
                    const objectId = bboxData.objectRuntimeId;

                    // Define 8 vertices of the bounding box (in mm)
                    const vertices = [
                        { x: bbox.min.x * 1000, y: bbox.min.y * 1000, z: bbox.min.z * 1000 }, // 0: bottom-front-left
                        { x: bbox.max.x * 1000, y: bbox.min.y * 1000, z: bbox.min.z * 1000 }, // 1: bottom-front-right
                        { x: bbox.max.x * 1000, y: bbox.max.y * 1000, z: bbox.min.z * 1000 }, // 2: bottom-back-right
                        { x: bbox.min.x * 1000, y: bbox.max.y * 1000, z: bbox.min.z * 1000 }, // 3: bottom-back-left
                        { x: bbox.min.x * 1000, y: bbox.min.y * 1000, z: bbox.max.z * 1000 }, // 4: top-front-left
                        { x: bbox.max.x * 1000, y: bbox.min.y * 1000, z: bbox.max.z * 1000 }, // 5: top-front-right
                        { x: bbox.max.x * 1000, y: bbox.max.y * 1000, z: bbox.max.z * 1000 }, // 6: top-back-right
                        { x: bbox.min.x * 1000, y: bbox.max.y * 1000, z: bbox.max.z * 1000 }, // 7: top-back-left
                    ];

                    // Define 12 edges of the bounding box
                    const edges = [
                        // Bottom face (4 edges)
                        [0, 1], [1, 2], [2, 3], [3, 0],
                        // Top face (4 edges)
                        [4, 5], [5, 6], [6, 7], [7, 4],
                        // Vertical edges (4 edges)
                        [0, 4], [1, 5], [2, 6], [3, 7]
                    ];

                    // Create line markup for each edge
                    for (const [startIdx, endIdx] of edges) {
                        const start = vertices[startIdx];
                        const end = vertices[endIdx];

                        lineMarkups.push({
                            start: {
                                positionX: start.x,
                                positionY: start.y,
                                positionZ: start.z,
                                modelId: modelId,
                                objectId: objectId
                            },
                            end: {
                                positionX: end.x,
                                positionY: end.y,
                                positionZ: end.z,
                                modelId: modelId,
                                objectId: objectId
                            },
                            color: { r: 0, g: 99, b: 163, a: 1 } // Trimble blue
                        });
                    }
                }
            }

            const result = await this.api.markup.addLineMarkups(lineMarkups);
            this.lineMarkupIds.push(...result.map(m => m.id));

            const boxCount = lineMarkups.length / 12;
            this.log(`✅ Created ${boxCount} bounding box(es) with ${lineMarkups.length} lines`);
            this.updateStatus(`✅ ${boxCount} bounding box(es) displayed`, 'success');

        } catch (error) {
            this.log(`❌ Error creating bounding box: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`, 'warning');
        }
    }

    updateStatus(message, type = 'info') {
        const statusDiv = document.getElementById('status');
        this.log(`[${type.toUpperCase()}] ${message}`);
        if (!statusDiv) return;
        statusDiv.textContent = message;
        statusDiv.dataset.statusType = type;
    }

    async ensurePropertyCatalogLoaded(forceReload = false) {
        if (this.propertyCatalogLoaded && !forceReload) return true;
        if (this.propertyCatalogPromise && !forceReload) return this.propertyCatalogPromise;

        this.propertyCatalogPromise = this.loadPropertyCatalog(forceReload)
            .finally(() => {
                this.propertyCatalogPromise = null;
            });

        return this.propertyCatalogPromise;
    }

    schedulePropertyCatalogWarmup() {
        if (this.propertyCatalogWarmupTimer) {
            clearTimeout(this.propertyCatalogWarmupTimer);
        }

        this.propertyCatalogWarmupTimer = setTimeout(() => {
            this.propertyCatalogWarmupTimer = null;
            if (!this.propertyCatalogLoaded) {
                this.log('🔁 Warmup refresh for property catalog...');
                this.ensurePropertyCatalogLoaded(true);
            }
        }, 2500);
    }

    async loadPropertyCatalog(forceReload = false) {
        const propertySelector = document.getElementById('property-names');
        const phasePropertySelector = document.getElementById('phase-property-names');
        if (!propertySelector && !phasePropertySelector) return;

        try {
            if (forceReload) {
                this.propertyCatalogLoaded = false;
            }
            if (propertySelector) propertySelector.disabled = true;
            if (phasePropertySelector) phasePropertySelector.disabled = true;
            this.renderPropertySelectorPlaceholder('Loading model properties...');
            this.updateStatus('Loading attributes and property sets from visible models...', 'info');
            this.log('Loading attributes and property sets from visible models...');
            const catalog = await this.waitForPropertyCatalog();
            const selectedCount = catalog.meta.length + catalog.product.length + catalog.psets.length;

            this.renderPropertySelectorOptions(catalog);
            this.propertyCatalogLoaded = true;
            this.propertyCatalogRetryCount = 0;
            this.updateStatus(`✅ Connected! ${selectedCount} attributes and properties ready for labeling.`, 'success');
            this.log(`✅ Property catalog loaded with ${selectedCount} option(s)`);
            if (this.phasePropertyName) {
                this.loadPhaseSequenceValues();
            }
            return true;
        } catch (error) {
            this.renderPropertySelectorPlaceholder('Unable to load model properties');
            this.updateStatus(`Could not load model properties: ${error.message}`, 'warning');
            this.log(`❌ Error loading property catalog: ${error.message}`);
            return false;
        } finally {
            if (propertySelector) propertySelector.disabled = false;
            if (phasePropertySelector) phasePropertySelector.disabled = false;
        }
    }

    async waitForPropertyCatalog() {
        while (true) {
            const modelObjects = await this.api.viewer.getObjects();
            if (!modelObjects || modelObjects.length === 0) {
                this.propertyCatalogRetryCount += 1;
                this.log(`⏳ Waiting for models in Trimble Connect... attempt ${this.propertyCatalogRetryCount}`);
                await this.delay(1500);
                continue;
            }

            const catalog = await this.collectPropertyCatalog(modelObjects);
            const selectedCount = catalog.meta.length + catalog.product.length + catalog.psets.length;
            if (selectedCount === 0) {
                this.propertyCatalogRetryCount += 1;
                this.log(`⏳ Waiting for model metadata... attempt ${this.propertyCatalogRetryCount}`);
                await this.delay(1500);
                continue;
            }

            return catalog;
        }
    }

    delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    async collectPropertyCatalog(modelObjects) {
        const catalog = {
            meta: new Map(),
            product: new Map(),
            psets: new Map()
        };

        for (const modelGroup of modelObjects) {
            const runtimeIds = (modelGroup.objects || [])
                .map(object => object?.id ?? object?.objectRuntimeId)
                .filter(id => Number.isInteger(id));

            if (runtimeIds.length === 0) continue;

            this.log(`📚 Scanning ${runtimeIds.length} object(s) from model ${modelGroup.modelId}`);

            for (let index = 0; index < runtimeIds.length; index += 200) {
                const batchIds = runtimeIds.slice(index, index + 200);
                let objectProperties = (modelGroup.objects || []).slice(index, index + 200);
                const needsHydration = objectProperties.some(objectProps =>
                    !objectProps || (!objectProps.product && !objectProps.properties)
                );

                if (needsHydration) {
                    objectProperties = await this.api.viewer.getObjectProperties(modelGroup.modelId, batchIds);
                }

                for (const objectProps of objectProperties) {
                    this.addObjectPropertiesToCatalog(objectProps, catalog);
                }
            }
        }

        return {
            meta: this.sortCatalogEntries(catalog.meta),
            product: this.sortCatalogEntries(catalog.product),
            psets: this.sortCatalogEntries(catalog.psets)
        };
    }

    addObjectPropertiesToCatalog(objectProps, catalog) {
        if (!objectProps) return;

        if (objectProps.class) {
            this.addCatalogEntry(catalog.meta, 'meta::class', 'Object Class');
        }
        if (objectProps.color) {
            this.addCatalogEntry(catalog.meta, 'meta::color', 'Object Color');
        }

        if (objectProps.product && typeof objectProps.product === 'object') {
            for (const [key, value] of Object.entries(objectProps.product)) {
                if (value === undefined || value === null || value === '') continue;
                if (typeof value === 'object') continue;

                const labelPrefix = this.ifcCoreAttributes[key.toLowerCase()] ? 'Attribute' : 'Product';
                this.addCatalogEntry(
                    catalog.product,
                    `${labelPrefix === 'Attribute' ? 'core' : 'product'}::${key}`,
                    `${labelPrefix} / ${this.formatPropertyLabel(key)}`
                );
            }
        }

        if (!Array.isArray(objectProps.properties)) return;

        for (const pset of objectProps.properties) {
            const setName = (pset?.set || pset?.name || '').trim();
            if (!setName || !pset.properties) continue;

            const normalizedProperties = this.normalizeProperties(pset.properties);
            for (const propertyName of Object.keys(normalizedProperties)) {
                this.addCatalogEntry(
                    catalog.psets,
                    `pset::${setName}::${propertyName}`,
                    `${setName} / ${this.formatPropertyLabel(propertyName)}`
                );
            }
        }
    }

    addCatalogEntry(targetMap, value, label) {
        if (!targetMap.has(value)) {
            targetMap.set(value, { value, label });
        }
    }

    sortCatalogEntries(entryMap) {
        return Array.from(entryMap.values()).sort((a, b) => a.label.localeCompare(b.label));
    }

    renderPropertySelectorPlaceholder(placeholderText) {
        this.renderCatalogSelectorPlaceholder('property-names', placeholderText);
        this.renderCatalogSelectorPlaceholder('phase-property-names', placeholderText);
    }

    renderPropertySelectorOptions(catalog) {
        this.propertyOptionMap.clear();
        this.phasePropertyOptionMap.clear();

        this.renderCatalogSelectorOptions(
            'property-names',
            catalog,
            this.propertyOptionMap,
            this.pendingPropertySelection || this.propertyNames[0] || ''
        );

        this.renderCatalogSelectorOptions(
            'phase-property-names',
            catalog,
            this.phasePropertyOptionMap,
            this.phasePropertyName || ''
        );

        const propertySelector = document.getElementById('property-names');
        if (propertySelector && propertySelector.value && this.propertyOptionMap.has(propertySelector.value)) {
            this.propertyNames = [propertySelector.value];
        } else {
            this.propertyNames = [];
        }

        const phaseSelector = document.getElementById('phase-property-names');
        if (phaseSelector && this.phasePropertyOptionMap.has(phaseSelector.value)) {
            this.phasePropertyName = phaseSelector.value;
        }
    }

    appendOptionGroup(propertySelector, label, options) {
        if (!options || options.length === 0) return;

        const group = document.createElement('optgroup');
        group.label = label;

        options.forEach(optionData => {
            const option = document.createElement('option');
            option.value = optionData.value;
            option.textContent = optionData.label;
            group.appendChild(option);
            this.propertyOptionMap.set(optionData.value, optionData.label);
        });

        propertySelector.appendChild(group);
    }

    renderCatalogSelectorPlaceholder(selectorId, placeholderText) {
        const propertySelector = document.getElementById(selectorId);
        if (!propertySelector) return;

        propertySelector.innerHTML = '';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = placeholderText;
        option.selected = true;
        propertySelector.appendChild(option);
    }

    renderCatalogSelectorOptions(selectorId, catalog, targetMap, preferredValue) {
        const propertySelector = document.getElementById(selectorId);
        if (!propertySelector) return;

        propertySelector.innerHTML = '';
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = 'Select an attribute or property';
        propertySelector.appendChild(placeholderOption);

        this.appendOptionGroupToMap(propertySelector, 'Attributes', catalog.meta, targetMap);
        this.appendOptionGroupToMap(propertySelector, 'Product Data', catalog.product, targetMap);
        this.appendOptionGroupToMap(propertySelector, 'Property Sets', catalog.psets, targetMap);

        if (preferredValue && targetMap.has(preferredValue)) {
            propertySelector.value = preferredValue;
        } else {
            propertySelector.value = '';
        }
    }

    appendOptionGroupToMap(propertySelector, label, options, targetMap) {
        if (!options || options.length === 0) return;

        const group = document.createElement('optgroup');
        group.label = label;

        options.forEach(optionData => {
            const option = document.createElement('option');
            option.value = optionData.value;
            option.textContent = optionData.label;
            group.appendChild(option);
            targetMap.set(optionData.value, optionData.label);
        });

        propertySelector.appendChild(group);
    }

    getPropertyOptionLabel(value) {
        return this.propertyOptionMap.get(value) || value;
    }

    formatPropertyLabel(propertyName) {
        if (!propertyName) return '';
        return String(propertyName)
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    log(message) {
        console.log(message);
        const logDiv = document.getElementById('log');
        if (!logDiv) return;
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">[${time}]</span> ${message}`;
        logDiv.insertBefore(entry, logDiv.firstChild);
    }
}

// Initialize when DOM is ready
let markupTool;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.__typsaMarkupToolInitialized) return;
        window.__typsaMarkupToolInitialized = true;
        markupTool = new AttributeMarkupTool();
        window.markupTool = markupTool;
    });
} else {
    if (!window.__typsaMarkupToolInitialized) {
        window.__typsaMarkupToolInitialized = true;
        markupTool = new AttributeMarkupTool();
        window.markupTool = markupTool;
    }
}

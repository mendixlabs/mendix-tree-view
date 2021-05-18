import { observable, action, configure, computed, flow } from "mobx";
import arrayToTree, { Tree } from "array-to-tree";

import { ValidationMessage } from "@jeltemx/mendix-react-widget-utils/lib/validation";
import { EntryObject, EntryObjectOptions, EntryObjectExtraOptions, TreeObject } from "./objects/entry";
import { RelationType } from "../../typings/TreeViewProps";
import { getObject } from "@jeltemx/mendix-react-widget-utils";

configure({ enforceActions: "observed" });

export interface TreeGuids {
    context: string | null;
    entries?: string[];
}

export interface NodeStoreConstructorOptions {
    contextObject?: mendix.lib.MxObject;
    loadFull: boolean;
    stateFull: boolean;
    holdSelection?: boolean;
    subscriptionHandler?: (guids: TreeGuids) => void;
    onLoadSelectionHandler?: (obj: mendix.lib.MxObject) => void;
    validationMessages: ValidationMessage[];
    entryObjectAttributes: EntryObjectAttributes;
    childLoader: (parent: EntryObject, expandAfter: string | null) => Promise<void>;
    searchHandler?: (_query: string) => Promise<mendix.lib.MxObject[] | null>;
    getInitialTableState: (guid: string) => TableState;
    writeTableState: (state: TableState) => void;
    debug: (...args: unknown[]) => void;
}

export interface TableState {
    context: string | null;
    lastUpdate?: number;
    expanded: string[];
    selected: string[];
}

export interface EntryObjectAttributes {
    childRef: string | null;
    hasChildAttr: string | null;
    parentRef: string | null;
    rootAttr: string | null;
    iconAttr: string | null;
    classAttr: string | null;
    relationType: RelationType;
}

const arrayToTreeOpts = {
    parentProperty: "parent",
    customID: "guid"
};

export class NodeStore {
    // Properties
    public subscriptionHandler: (guids: TreeGuids) => void;
    public onLoadSelectionHandler: (obj: mendix.lib.MxObject) => void;
    public entryObjectAttributes: EntryObjectAttributes;
    public childLoader: (parent: EntryObject, expandAfter?: string | null) => Promise<void> = async () => {};
    public searchHandler: ((_query: string) => Promise<mendix.lib.MxObject[] | null>) | null;
    public debug: (...args: unknown[]) => void;

    @observable public isLoading: boolean;
    @observable public contextObject: mendix.lib.MxObject | null;
    @observable public entries: EntryObject[] = [];
    @observable public filter: string[] = [];
    @observable public searchQuery = "";

    @observable public width = 0;
    @observable public height = 0;

    @observable public resetState = false;

    @observable public validationMessages: ValidationMessage[] = [];

    private loadFull = false;
    private stateFull = false;
    private holdSelection = false;
    private expandedMapping: { [key: string]: string[] } = {};
    private onExpandChange = this._onExpandChange.bind(this);

    private getInitialTableState: (guid: string) => TableState;
    private writeTableState: (state: TableState) => void;

    constructor(opts: NodeStoreConstructorOptions) {
        const {
            contextObject,
            stateFull,
            loadFull,
            holdSelection,
            subscriptionHandler,
            onLoadSelectionHandler,
            validationMessages,
            entryObjectAttributes,
            searchHandler,
            childLoader,
            getInitialTableState,
            writeTableState,
            debug
        } = opts;

        this.isLoading = false;
        this.stateFull = stateFull;
        this.loadFull = typeof loadFull !== "undefined" ? loadFull : false;
        this.holdSelection = typeof holdSelection !== "undefined" ? holdSelection : false;
        this.contextObject = contextObject || null;
        this.subscriptionHandler = subscriptionHandler || ((): void => {});
        this.onLoadSelectionHandler = onLoadSelectionHandler || ((): void => {});
        this.searchHandler = searchHandler || null;
        this.getInitialTableState = getInitialTableState;
        this.writeTableState = writeTableState;
        this.debug = debug || ((): void => {});
        this.entryObjectAttributes = entryObjectAttributes || {
            childRef: null,
            hasChildAttr: null,
            parentRef: null,
            rootAttr: null,
            iconAttr: null,
            relationType: "nodeParent"
        };

        if (childLoader) {
            this.childLoader = childLoader;
        }

        this.validationMessages = validationMessages || [];
    }

    search = flow(function*(this: NodeStore, query: string) {
        if (this.searchHandler === null) {
            return;
        }
        this.setLoading(true);
        this.searchQuery = query;
        const objects: mendix.lib.MxObject[] | null = yield this.searchHandler(query);
        this.setLoading(false);
        if (objects === null) {
            return;
        }
        this.filter = objects.map(o => o.getGuid());
        if (query !== "" && this.filter.length > 0) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    });

    // Entries
    @action
    setEntries(
        entryObjects: mendix.lib.MxObject[],
        opts: EntryObjectExtraOptions,
        clean = true,
        expandAfter: string | null = null
    ): void {
        this.debug("store: setEntries", entryObjects.length, opts, clean);
        const entries = entryObjects.map(mxObject => this.createEntryObject(mxObject, this.entryHandler(opts), opts));

        if (clean) {
            this.entries = entries;
            this.filter = [];
            this.searchQuery = "";

            if (this.loadFull && this.contextObject) {
                if (!this.stateFull && this.expandedMapping[this.contextObject.getGuid()]) {
                    const mapping = this.expandedMapping[this.contextObject.getGuid()];
                    this.writeTableState({
                        context: this.contextObject.getGuid(),
                        expanded: mapping,
                        selected: []
                    });
                    this.entries.forEach(entry => {
                        if (entry.guid && mapping.find(m => m === entry.guid)) {
                            entry.setExpanded(true);
                        }
                    });
                } else if (this.stateFull) {
                    const initialTablesState = this.getInitialTableState(this.contextObject.getGuid());
                    const initialState: TableState = {
                        context: initialTablesState.context,
                        selected: initialTablesState.selected.filter(s => !!entries.find(e => e.guid === s)),
                        expanded: initialTablesState.expanded.filter(s => !!entries.find(e => e.guid === s))
                    };
                    // We're doing this one by one, because expand will overwrite selected in state
                    this.entries.forEach(entry => {
                        if (entry.guid && initialState.selected.indexOf(entry.guid) !== -1) {
                            entry.setSelected(true);
                            this.onLoadSelectionHandler(entry._obj);
                        }
                    });
                    this.entries.forEach(entry => {
                        if (entry.guid && initialState.expanded.indexOf(entry.guid) !== -1) {
                            entry.setExpanded(true);
                        }
                    });
                }
            }
        } else {
            const cloned = [...this.entries];
            const clonedIds = cloned.map(e => e.guid);
            entries.forEach(entry => {
                const index = clonedIds.indexOf(entry.guid);
                if (index !== -1) {
                    cloned[index].clearSubscriptions();
                    cloned[index] = entry;
                } else {
                    cloned.push(entry);
                }
            });
            this.entries = cloned;
        }

        if (expandAfter !== null) {
            this.expandKey(expandAfter, true);
        }
    }

    @action
    setEntry(entryObject: mendix.lib.MxObject, opts: EntryObjectExtraOptions): void {
        this.setEntries([entryObject], opts, false);
    }

    @action
    removeEntry(guid: string): void {
        const found = this.entries.findIndex(entry => entry.guid === guid);
        if (found !== -1) {
            const cloned = [...this.entries];
            const entry = cloned[found];
            entry.clearSubscriptions();
            cloned.splice(found, 1);
            this.entries = cloned;
        }
    }

    @action
    switchEntryParent(nodeGuid?: string, targetParent?: string): void {
        if (!nodeGuid || !targetParent || this.entryObjectAttributes.relationType === "nodeChildren") {
            return;
        }
        const node = this.findEntry(nodeGuid);
        const parent = this.findEntry(targetParent);

        if (!node || !parent || node.isRoot) {
            return;
        }

        node.setParent(parent.guid, true);
    }

    loadEntryChildren(entryObject: EntryObject): void {
        if (!entryObject || !entryObject.mxObject) {
            return;
        }
        this.childLoader(entryObject);
    }

    // Other

    @action
    setContext(obj?: mendix.lib.MxObject): void {
        this.debug("Store: setContext", obj);

        if (
            this.contextObject === null ||
            !obj ||
            (this.contextObject && obj && this.contextObject.getGuid() !== obj.getGuid())
        ) {
            this.resetState = true;
        }

        if (this.contextObject && this.searchQuery === "") {
            this.expandedMapping[this.contextObject.getGuid()] = this.expandedKeys;
            this.writeTableState({
                context: this.contextObject.getGuid(),
                expanded: this.expandedKeys,
                selected: this.selectedEntriesIds
            });
        }

        this.contextObject = obj || null;
    }

    @action
    setLoading(state: boolean): void {
        this.isLoading = state;
    }

    // Dimensions

    @action
    setDimenions(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    @action
    setWidth(width: number): void {
        this.width = width;
    }

    @action
    setHeight(height: number): void {
        this.height = height;
    }

    // Selection

    @computed
    get selectedEntries(): EntryObject[] {
        return this.entries.filter(entry => entry.selected);
    }

    @computed
    get selectedEntriesIds(): string[] {
        return this.entries.filter(entry => entry.selected).map(entry => entry.guid);
    }

    @action
    selectEntry(guid: string, expandChange = true): void {
        if (!this.holdSelection) {
            return;
        }
        let selectedFound = false;
        this.selectedEntries.forEach(entry => {
            if (entry.guid !== guid) {
                entry.setSelected(false);
            } else {
                selectedFound = true;
            }
        });
        if (!selectedFound) {
            const entry = this.findEntry(guid);
            if (entry) {
                entry.setSelected(true);
            }
        }
        if (expandChange) {
            this.onExpandChange();
        }
    }

    @action
    setSelectedFromExternal(guid: string): void {
        if (!this.holdSelection) {
            return;
        }
        const found = this.entries.find(e => e.guid === guid);
        this.debug("setSelectedFromExternal", guid, found);
        if (found) {
            const obj = found.obj;
            const parentIds = this.getParents(obj).map(obj => obj.guid);
            const toCollapse = this.expandedKeys.filter(expanded => !parentIds.find(p => p === expanded));
            toCollapse.forEach(id => this.expandKey(id, false, false));
            parentIds.forEach(p => this.expandKey(p, true, false));
            this.selectEntry(found.guid);
        }
    }

    // Expanded
    get expandedKeys(): string[] {
        return this.entries.filter(e => e.isExpanded).map(e => e.guid);
    }

    @action
    expandKey(guid: string, expanded: boolean, onChange = true): void {
        const entryObject = this.findEntry(guid);
        if (entryObject) {
            if (expanded && !entryObject.isLoaded) {
                this.childLoader(entryObject, guid);
            } else {
                entryObject.setExpanded(expanded, onChange);
            }
        }
    }

    @action
    expandAll(): void {
        const arrayTree = this.entryTree;
        const walkTree = (branch: arrayToTree.Tree<TreeObject>): void => {
            if (branch.children) {
                const entry = this.findEntry(branch.guid);
                if (entry) {
                    entry.setExpanded(true);
                }
                branch.children.forEach((child: Tree<TreeObject>) => walkTree(child));
            }
        };
        arrayTree.forEach(child => {
            walkTree(child);
        });
    }

    @action
    collapseAll(): void {
        this.entries.forEach(entry => entry.isExpanded && entry.setExpanded(false));
    }

    @computed
    get disabled(): boolean {
        const fatalCount = this.validationMessages.filter(m => m.fatal).length;
        return fatalCount > 0 || this.contextObject === null;
    }

    @action addValidationMessage(message: ValidationMessage): void {
        this.validationMessages.push(message);
    }

    @action removeValidationMessage(id: string): void {
        const messages = [...this.validationMessages];
        const found = messages.findIndex(m => m.id === id);
        if (found !== -1) {
            messages.splice(found, 1);
            this.validationMessages = messages;
        }
    }

    // Entries

    @computed
    get treeMapping(): { [key: string]: string } {
        const needParentMapping = this.entryObjectAttributes.relationType === "nodeChildren";
        const treeMapping: { [key: string]: string } = {};

        if (needParentMapping) {
            this.entries.forEach(entry => {
                const obj = entry.obj;
                if (obj.children) {
                    obj.children.forEach(child => {
                        treeMapping[child] = obj.guid;
                    });
                }
            });
        } else {
            this.entries.forEach(entry => {
                const obj = entry.obj;
                if (obj.parent) {
                    treeMapping[obj.guid] = obj.parent;
                }
            });
        }

        return treeMapping;
    }

    @computed
    get entryList(): TreeObject[] {
        const needParentMapping = this.entryObjectAttributes.relationType === "nodeChildren";
        const treeMapping = this.treeMapping;

        let entries: TreeObject[] = [...this.entries].map(entry => {
            const obj = entry.obj;
            obj.highlight = false;
            if (needParentMapping && treeMapping[obj.guid]) {
                obj.parent = treeMapping[obj.guid];
            }
            return obj;
        });

        if (this.searchQuery !== "") {
            const rawEntries = [...entries]
                .filter(e => this.filter.indexOf(e.guid) !== -1)
                .map(o => {
                    o.highlight = true;
                    return o;
                });
            const rawGuids = rawEntries.map(e => e.guid);
            const parents = rawEntries.map(e => this.getParents(e));
            parents.forEach(parentsArray => {
                parentsArray.forEach(parent => {
                    if (rawGuids.indexOf(parent.guid) === -1) {
                        rawGuids.push(parent.guid);
                        parent.highlight = false;
                        rawEntries.push(parent);
                    }
                });
            });
            entries = rawEntries;
        }

        return entries;
    }

    @computed
    get entryTree(): Tree<TreeObject>[] {
        const tree = arrayToTree(this.entryList, arrayToTreeOpts);

        // We filter out any objects that don't have a parent and are not root
        return tree.filter(treeEl => !(!treeEl.parent && !treeEl.root));
    }

    private createEntryObject(
        mxObject: mendix.lib.MxObject,
        changeHandler = (..._opts: unknown[]): void => {},
        opts: EntryObjectExtraOptions
    ): EntryObject {
        const entryObjectOptions: EntryObjectOptions = {
            mxObject,
            changeHandler,
            onExpandChange: this.onExpandChange,
            extraOpts: opts
        };

        const entry = new EntryObject(entryObjectOptions, this.entryObjectAttributes);
        return entry;
    }

    public findEntry(guid: string): EntryObject | null {
        if (!this.entries) {
            return null;
        }
        const found = this.entries.find(e => e.guid === guid);
        return found || null;
    }

    private entryHandler(
        opts: EntryObjectExtraOptions
    ): (guid: string, removedCB: (removed: boolean) => void) => Promise<void> {
        return async (guid: string, removedCB: (removed: boolean) => void): Promise<void> => {
            const object = await getObject(guid);
            if (object) {
                const found = this.entries.findIndex(entry => entry.guid === object.getGuid());
                if (found !== -1) {
                    this.setEntry(object, opts);
                    removedCB && removedCB(false);
                }
            } else {
                this.removeEntry(guid);
                removedCB && removedCB(true);
            }
        };
    }

    private getParents(treeObject: TreeObject): TreeObject[] {
        let parentGuid = this.treeMapping[treeObject.guid];
        const returnArray: TreeObject[] = [];
        while (parentGuid) {
            const parent = this.findEntry(parentGuid);
            if (parent) {
                returnArray.push(parent.obj);
                parentGuid = this.treeMapping[parent.guid];
            } else {
                break;
            }
        }
        return returnArray;
    }

    private _onExpandChange(): void {
        // this.debug("store: onExpandChange", this.expandedKeys);
        if (this.contextObject) {
            this.writeTableState({
                context: this.contextObject.getGuid(),
                selected: this.selectedEntriesIds,
                expanded: this.expandedKeys
            });
        }
    }
}

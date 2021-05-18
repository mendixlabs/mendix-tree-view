import { Component, ReactNode, createElement, ReactElement, createRef } from "react";
import { findDOMNode } from "react-dom";
import store from "store2";

import { TreeViewComponent } from "./components/TreeViewComponent";
import { TreeViewContainerProps } from "../typings/TreeViewProps";

import "antd/es/tree/style/index.css";
import "antd/es/spin/style/index.css";
import "antd/es/empty/style/index.css";
import "antd/es/input/style/index.css";

import "./ui/TreeView.scss";

import { NodeStore, NodeStoreConstructorOptions, TableState } from "./store/index";
import {
    IAction,
    getObjectContextFromObjects,
    executeMicroflow,
    executeNanoflow,
    openPage,
    fetchByXpath,
    getObjects,
    createObject,
    deleteObject,
    debug,
    ActionReturnType
} from "@jeltemx/mendix-react-widget-utils";
import { splitRef } from "./utils/index";
import { EntryObjectExtraOptions, EntryObject } from "./store/objects/entry";
import { getStaticTitleFromObject, getDynamicTitleFromObject, ClickCellType } from "./utils/titlehelper";
import { validateProps } from "./utils/validation";
import { commitObject } from "@jeltemx/mendix-react-widget-utils";

export interface Action extends IAction {}
export type ActionReturn = string | number | boolean | mendix.lib.MxObject | mendix.lib.MxObject[] | void;

class TreeView extends Component<TreeViewContainerProps> {
    ref = createRef<HTMLDivElement>();

    private store: NodeStore;
    private widgetId?: string;
    private searchEnabled: boolean;

    fetchData = this._fetchData.bind(this);
    fetchChildren = this._fetchChildren.bind(this);
    executeAction = this._executeAction.bind(this);
    getEntryOptions = this._getEntryOptions.bind(this);
    getClassMethod = this._getClassMethod.bind(this);
    getInitialState = this._getInitialState.bind(this);
    writeTableState = this._writeTableState.bind(this);
    clickTypeHandler = this._clickTypeHandler.bind(this);
    createSearchHelper = this._createSearchHelper.bind(this);
    onLoadSelectionHandler = this._onLoadSelectionHandler.bind(this);
    search = this._search.bind(this);
    debug = this._debug.bind(this);

    constructor(props: TreeViewContainerProps) {
        super(props);

        const parentRef = props.relationType === "nodeParent" ? splitRef(props.relationNodeParent) : null;
        const childRef = props.relationType === "nodeChildren" ? splitRef(props.relationChildReference) : null;
        const hasChildAttr = props.relationNodeParentHasChildAttr !== "" ? props.relationNodeParentHasChildAttr : null;
        const searchNodeRef = props.searchNodeReference !== "" ? splitRef(props.searchNodeReference) : null;
        const relationType = props.relationType;
        const rootAttr = props.nodeIsRootAttr !== "" ? props.nodeIsRootAttr : null;
        const iconAttr = props.uiNodeIconAttr !== "" ? props.uiNodeIconAttr : null;
        const classAttr = props.uiNodeClassName !== "" ? props.uiNodeClassName : null;
        const loadFull = props.nodeLoadScenario === "all";

        this.searchEnabled =
            props.searchEnabled &&
            props.nodeLoadScenario === "all" &&
            searchNodeRef !== null &&
            props.searchHelperEntity !== "" &&
            props.searchStringAttribute !== "" &&
            !!props.searchNanoflow.nanoflow;

        const validationMessages = validateProps(props);

        const storeOpts: NodeStoreConstructorOptions = {
            holdSelection: props.selectionSelectOnClick,
            loadFull,
            entryObjectAttributes: {
                childRef,
                parentRef,
                hasChildAttr,
                relationType,
                rootAttr,
                iconAttr,
                classAttr
            },
            childLoader: this.fetchChildren,
            validationMessages,
            getInitialTableState: this.getInitialState,
            onLoadSelectionHandler: this.onLoadSelectionHandler,
            writeTableState: this.writeTableState,
            stateFull: props.stateManagementType !== "disabled" && props.nodeLoadScenario === "all",
            debug: this.debug
        };

        if (this.searchEnabled) {
            storeOpts.searchHandler = this.search;
        }

        this.store = new NodeStore(storeOpts);
    }

    componentWillReceiveProps(nextProps: TreeViewContainerProps): void {
        if (!this.widgetId && this.ref.current) {
            try {
                const domNode = findDOMNode(this);
                // @ts-ignore
                this.widgetId = domNode.getAttribute("widgetId") || undefined;
            } catch (error) {
                const domNode = findDOMNode(this.ref.current);
                // @ts-ignore
                const alternativeID = domNode.getAttribute("data-mendix-id") || undefined;
                this.widgetId = alternativeID;
            }
        }

        if (nextProps.experimentalExposeSetSelected && this.store.contextObject) {
            this.deleteExposedMethod();
        }

        this.store.setContext(nextProps.mxObject);

        if (nextProps.mxObject) {
            this.store.setLoading(true);
            this.fetchData(nextProps.mxObject);
        }

        if (nextProps.experimentalExposeSetSelected && nextProps.mxObject) {
            const guid = nextProps.mxObject.getGuid();
            const methodName = `__TreeView_${guid}_select`;
            // @ts-ignore
            window[methodName] = this.store.setSelectedFromExternal.bind(this.store);
            this.debug(`Expose external select method: window.${methodName}`);
        }
    }

    componentWillUnmount(): void {
        this.deleteExposedMethod();
    }

    render(): ReactNode {
        const {
            dragIsDraggable,
            uiNodeIconIsGlyphicon,
            uiNodeIconAttr,
            selectionSelectOnClick,
            uiTableShowLines
        } = this.props;
        const showIcon = uiNodeIconAttr !== "";
        return (
            <div ref={this.ref}>
                <TreeViewComponent
                    className={this.props.class}
                    searchEnabled={this.searchEnabled}
                    holdSelection={selectionSelectOnClick}
                    showLine={uiTableShowLines}
                    store={this.store}
                    showIcon={showIcon}
                    iconIsGlyphicon={uiNodeIconIsGlyphicon}
                    draggable={dragIsDraggable}
                    onClickHandler={this.clickTypeHandler}
                    switcherBg={this.props.uiSwitcherBg}
                />
            </div>
        );
    }

    private deleteExposedMethod(): void {
        const guid = this.store.contextObject?.getGuid();
        const methodName = `__TreeView_${guid}_select`;
        // @ts-ignore
        if (guid && typeof window[methodName] !== "undefined") {
            // @ts-ignore
            delete window[methodName];
            this.debug(`Remove external select method: window.${methodName}`);
        }
    }

    private async _fetchData(object: mendix.lib.MxObject): Promise<void> {
        this.debug("fetchData", object.getGuid());
        const {
            nodeEntity,
            nodeConstraint,
            nodeDataSource,
            nodeGetDataMicroflow,
            nodeGetDataNanoflow,
            nodeLoadScenario
        } = this.props;
        if (!nodeEntity) {
            return;
        }

        let objects: mendix.lib.MxObject[] | null = null;

        try {
            if (nodeDataSource === "xpath" && object) {
                objects = await fetchByXpath(object, nodeEntity, nodeConstraint);
            } else if (nodeDataSource === "microflow" && nodeGetDataMicroflow) {
                objects = (await this.executeAction(
                    { microflow: nodeGetDataMicroflow },
                    false,
                    object
                )) as mendix.lib.MxObject[];
            } else if (nodeDataSource === "nanoflow" && nodeGetDataNanoflow && nodeGetDataNanoflow.nanoflow) {
                objects = (await this.executeAction(
                    { nanoflow: nodeGetDataNanoflow },
                    false,
                    object
                )) as mendix.lib.MxObject[];
            }
        } catch (error) {
            window.mx.ui.error("An error occurred while executing retrieving data: ", error);
        }

        if (objects !== null) {
            const entryOpts = this.getEntryOptions({
                isRoot: nodeLoadScenario === "top"
            });

            if (nodeLoadScenario === "all") {
                entryOpts.isLoaded = true;
            }

            this.store.setEntries(objects, entryOpts);
        } else {
            this.store.setEntries([], {});
        }

        this.store.setLoading(false);
    }

    private async _fetchChildren(parentObject: EntryObject, expandAfter: string | null = null): Promise<void> {
        if (this.props.nodeLoadScenario === "all") {
            return;
        }
        this.debug("fetchChildren", parentObject);
        const {
            childScenario,
            childActionMethod,
            childActionMicroflow,
            childActionNanoflow,
            relationType
        } = this.props;

        let objects: mendix.lib.MxObject[] | null = null;

        try {
            this.store.setLoading(true);
            if (
                relationType === "nodeChildren" &&
                childScenario === "reference" &&
                this.store.entryObjectAttributes.childRef
            ) {
                const references = parentObject.mxObject.getReferences(this.store.entryObjectAttributes.childRef);
                objects = await getObjects(references);
            } else if (childScenario === "action" && childActionMethod === "microflow" && childActionMicroflow) {
                objects = (await this.executeAction(
                    { microflow: childActionMicroflow },
                    false,
                    parentObject.mxObject
                )) as mendix.lib.MxObject[];
            } else if (
                childScenario === "action" &&
                childActionMethod === "nanoflow" &&
                childActionNanoflow &&
                childActionNanoflow.nanoflow
            ) {
                objects = (await this.executeAction(
                    { nanoflow: childActionNanoflow },
                    false,
                    parentObject.mxObject
                )) as mendix.lib.MxObject[];
            } else {
                window.mx.ui.info("Cannot load data", false);
            }
        } catch (error) {
            window.mx.ui.error("An error occurred while executing retrieving children: ", error);
        }

        if (objects !== null) {
            const entryOpts = this.getEntryOptions({
                parent: parentObject.mxObject.getGuid()
            });

            this.store.setEntries(objects, entryOpts, false, expandAfter);
            parentObject.setLoaded(true);
        } else {
            parentObject.setHasChildren(false);
            parentObject.setLoaded(true);
        }

        this.store.setLoading(false);
    }

    private _getEntryOptions(opts: Partial<EntryObjectExtraOptions>): EntryObjectExtraOptions {
        const renderAsHTML = this.props.uiNodeRenderAsHTML;
        const titleType = this.props.uiNodeTitleType;
        const attribute = this.props.uiNodeTitleAttr;
        const nanoflow = this.props.uiNodeTitleNanoflow;

        if (titleType === "attribute" && attribute) {
            opts.staticTitleMethod = (obj: mendix.lib.MxObject): ReactElement =>
                getStaticTitleFromObject(obj, {
                    attribute,
                    titleType,
                    renderAsHTML
                });
        } else if (titleType === "nanoflow" && nanoflow.nanoflow) {
            opts.dynamicTitleMethod = (obj: mendix.lib.MxObject): Promise<ReactNode> =>
                getDynamicTitleFromObject(obj, {
                    executeAction: this.executeAction,
                    nanoflow,
                    titleType,
                    renderAsHTML
                });
        }

        return opts;
    }

    private _getClassMethod(attr: string): (obj: mendix.lib.MxObject) => string {
        return (obj: mendix.lib.MxObject): string => {
            if (!obj || !attr) {
                return "";
            }
            return obj.get(attr) as string;
        };
    }

    private async _clickTypeHandler(obj: mendix.lib.MxObject, clickType: ClickCellType = "single"): Promise<void> {
        if (!obj || this.props.eventNodeClickFormat !== clickType) {
            return;
        }

        const action: Action = {};

        if (this.props.eventNodeOnClickAction === "open" && this.props.eventNodeOnClickForm) {
            action.page = {
                pageName: this.props.eventNodeOnClickForm,
                openAs: this.props.eventNodeOnClickOpenPageAs
            };
        } else if (this.props.eventNodeOnClickAction === "microflow" && this.props.eventNodeOnClickMicroflow) {
            action.microflow = this.props.eventNodeOnClickMicroflow;
        } else if (this.props.eventNodeOnClickAction === "nanoflow" && this.props.eventNodeOnClickNanoflow.nanoflow) {
            action.nanoflow = this.props.eventNodeOnClickNanoflow;
        }

        if (
            typeof action.microflow !== "undefined" ||
            typeof action.nanoflow !== "undefined" ||
            typeof action.page !== "undefined"
        ) {
            this.executeAction(action, true, obj);
        }
    }

    // **********************
    // STATE MANAGEMENT
    // **********************

    private _getInitialState(guid: string): TableState {
        const {
            stateManagementType,
            stateLocalStorageKey,
            stateLocalStorageKeyIncludeGUID,
            // stateExecuteSelectActionOnRestore,
            stateLocalStorageType
        } = this.props;

        const key =
            stateLocalStorageKey !== ""
                ? `TreeViewState-${stateLocalStorageKey}${stateLocalStorageKeyIncludeGUID ? `-${guid}` : ""}`
                : `TreeViewState-${guid}`;
        const currentDateTime = +new Date();
        const emptyState: TableState = {
            context: guid,
            expanded: [],
            selected: []
        };
        if (stateManagementType === "disabled" /* || stateManagementType === "mendix"*/) {
            return emptyState;
        }
        const hasLocalStorage = stateLocalStorageType === "session" ? store.session.has(key) : store.local.has(key);

        if (!hasLocalStorage) {
            this.writeTableState(emptyState);
            return emptyState;
        }

        const localStoredState = (stateLocalStorageType === "session"
            ? store.session.get(key)
            : store.local.get(key)) as TableState | null;
        this.debug("getTableState", localStoredState);
        if (
            localStoredState &&
            localStoredState.lastUpdate &&
            currentDateTime - localStoredState.lastUpdate < this.props.stateLocalStorageTime * 1000 * 60
        ) {
            return localStoredState;
        }

        this.writeTableState(emptyState);
        return emptyState;
    }

    private _writeTableState(state: TableState): void {
        // We're doing this the dirty way instead of Object.assign because IE11 sucks
        const writeState = JSON.parse(JSON.stringify(state)) as TableState;
        const {
            stateManagementType,
            stateLocalStorageKey,
            stateLocalStorageKeyIncludeGUID,
            stateLocalStorageType
        } = this.props;
        if (stateManagementType === "disabled" /* || stateManagementType === "mendix"*/) {
            return;
        }
        this.debug("writeTableState", writeState);
        const key =
            stateLocalStorageKey !== ""
                ? `TreeViewState-${stateLocalStorageKey}${
                      stateLocalStorageKeyIncludeGUID ? `-${writeState.context}` : ""
                  }`
                : `TreeViewState-${writeState.context}`;
        writeState.lastUpdate = +new Date();
        if (stateLocalStorageType === "session") {
            store.session.set(key, writeState);
        } else {
            store.local.set(key, writeState);
        }
    }

    // **********************
    // SEARCH
    // **********************

    private _onLoadSelectionHandler(obj: mendix.lib.MxObject): void {
        const {
            stateManagementType,
            eventNodeOnClickAction,
            eventNodeClickFormat,
            stateExecuteSelectActionOnRestore
        } = this.props;

        if (
            obj &&
            stateManagementType !== "disabled" &&
            stateExecuteSelectActionOnRestore &&
            (eventNodeOnClickAction === "microflow" || eventNodeOnClickAction === "nanoflow")
        ) {
            this.clickTypeHandler(obj, eventNodeClickFormat);
        }
    }

    private async _search(query: string): Promise<mendix.lib.MxObject[] | null> {
        const { searchNanoflow } = this.props;

        if (!searchNanoflow) {
            window.mx.ui.error("Cannot create search, nanoflow undefined");
            return null;
        }

        const helper = await this.createSearchHelper(query);

        if (helper === null) {
            window.mx.ui.error("Cannot create search Helper entity!");
            return null;
        }

        const objects = (await this.executeAction({ nanoflow: searchNanoflow }, true, helper)) as mendix.lib.MxObject[];
        deleteObject(helper);

        return objects;
    }

    private async _createSearchHelper(query: string): Promise<mendix.lib.MxObject | null> {
        const { searchHelperEntity, searchNodeReference, searchStringAttribute } = this.props;
        const searchNodeRef = searchNodeReference !== "" ? splitRef(searchNodeReference) : null;

        if (!searchHelperEntity || !searchNodeRef || !searchStringAttribute) {
            window.mx.ui.error("Cannot create search Helper entity!");
            return null;
        }

        const helperObject = await createObject(searchHelperEntity);
        const nodeGuids = this.store.entries.map(e => e.guid);

        if (searchNodeRef) {
            helperObject.addReferences(searchNodeRef, nodeGuids);
        }

        if (searchStringAttribute) {
            helperObject.set(searchStringAttribute, query);
        }

        await commitObject(helperObject);

        return helperObject;
    }

    private _executeAction(action: Action, showError = false, obj?: mendix.lib.MxObject): Promise<ActionReturnType> {
        this.debug("executeAction", action, obj && obj.getGuid());
        const { mxform } = this.props;
        const context = getObjectContextFromObjects(obj, this.props.mxObject);

        if (action.microflow) {
            return executeMicroflow(action.microflow, context, mxform, showError);
        } else if (action.nanoflow) {
            return executeNanoflow(action.nanoflow, context, mxform, showError);
        } else if (action.page) {
            return openPage(action.page, context, showError);
        }

        return Promise.reject(
            new Error(`No microflow/nanoflow/page defined for this action: ${JSON.stringify(action)}`)
        );
    }

    private _debug(...args: unknown[]): void {
        const id = this.props.friendlyId || this.widgetId || "mendix.treeview.TreeView";
        debug(id, ...args);
    }
}

export default TreeView;

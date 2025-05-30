import Status from "../homepanel/Status";
import ManualFirePanel from "./ManualFirePanel";



export default function ManualFiring(props){

    return (
        <div className="justify-center items-center gap-2 my-6">
            <div className="flex flex-row w-full">
                <ManualFirePanel/>
            </div>
        </div>
    )
}